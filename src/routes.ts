import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import cp from 'child_process';
import db from './db';
import crypto from 'crypto';
import { VideoRecord } from './types';
import { getConfig, saveConfig } from './config';
import { startScanner, stopScanner } from './scanner';
import { getFfmpegPath, getFfmpegInfo, checkLatestRelease, updateFfmpeg, getUpdateState, onFfmpegUpdated } from './setup-ffmpeg';

const router = express.Router();
const HLS_TEMP_DIR = path.resolve(process.cwd(), 'hls_temp');
const SEGMENT_TIME = 3;

if (!fs.existsSync(HLS_TEMP_DIR)) fs.mkdirSync(HLS_TEMP_DIR, { recursive: true });

// ⚡ 화질별 독립 스트림 관리: 키 = "${videoId}_${quality}"
const activeStreams: Record<string, { 
    command?: cp.ChildProcess;
    timeout?: NodeJS.Timeout; 
    currentSeq?: number;
    startTime?: number;
    launching?: boolean;
    coldStart?: boolean;
}> = {};
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

const getStreamKey = (id: string, quality: string) => `${id}_${quality}`;

type TranscoderCodec =
    | 'libx264'
    | 'h264_nvenc'
    | 'h264_amf'
    | 'h264_vaapi'
    | 'h264_qsv';

interface EncoderProbeResult {
    id: TranscoderCodec;
    available: boolean;
    osSupported: boolean;
    device?: string;
    reason?: string;
}

const SUPPORTED_ENCODERS: TranscoderCodec[] = [
    'libx264',
    'h264_nvenc',
    'h264_amf',
    'h264_vaapi',
    'h264_qsv',
];

const ENCODER_OS_SUPPORT: Record<TranscoderCodec, NodeJS.Platform[]> = {
    libx264: ['win32', 'linux', 'darwin'],
    h264_nvenc: ['win32', 'linux'],
    h264_amf: ['win32', 'linux'],
    h264_vaapi: ['linux'],
    h264_qsv: ['win32', 'linux'],
};

const getLinuxRenderDevices = (): string[] => {
    if (os.platform() !== 'linux') return [];
    const envDev = process.env.DRI_RENDER_DEVICE;
    const devices: string[] = [];
    if (envDev && fs.existsSync(envDev)) devices.push(envDev);
    try {
        if (fs.existsSync('/dev/dri')) {
            const entries = fs.readdirSync('/dev/dri')
                .filter(name => /^renderD\d+$/.test(name))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                .map(name => `/dev/dri/${name}`);
            for (const dev of entries) {
                if (!devices.includes(dev)) devices.push(dev);
            }
        }
    } catch (e) {}
    return devices;
};

let availableEncoders: Set<string> | null = null;
const encoderProbeCache = new Map<TranscoderCodec, EncoderProbeResult>();
const detectedRenderDevices: Partial<Record<'h264_vaapi' | 'h264_qsv', string>> = {};
let probeAllInFlight: Promise<EncoderProbeResult[]> | null = null;

const clearEncoderCache = () => {
    availableEncoders = null;
    encoderProbeCache.clear();
    delete detectedRenderDevices.h264_vaapi;
    delete detectedRenderDevices.h264_qsv;
    probeAllInFlight = null;
};

onFfmpegUpdated(clearEncoderCache);

const killedProcesses = new WeakSet<cp.ChildProcess>();
const killEncoderProcess = (proc: cp.ChildProcess) => {
    killedProcesses.add(proc);
    try { proc.kill('SIGKILL'); } catch (e) {}
};

const getCompiledEncoders = (): Promise<Set<string>> => {
    return new Promise((resolve) => {
        if (availableEncoders) return resolve(availableEncoders);
        cp.execFile(getFfmpegPath(), ['-hide_banner', '-encoders'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout) {
                console.error('인코더 목록 조회 실패:', err?.message);
                return resolve(new Set());
            }
            const parsed = new Set<string>();
            for (const line of stdout.split(/\r?\n/)) {
                const match = /^\s*[VAS\.][F\.][S\.][X\.][B\.][D\.]\s+([^\s]+)\s/.exec(line);
                if (match) parsed.add(match[1]);
            }
            availableEncoders = parsed;
            resolve(availableEncoders);
        });
    });
};

const runFfmpegProbe = (args: string[]): Promise<{ ok: boolean; error: string }> => {
    return new Promise((resolve) => {
        cp.execFile(getFfmpegPath(), args, { timeout: 5000 }, (err, _stdout, stderr) => {
            if (!err) return resolve({ ok: true, error: '' });
            const msg = (stderr || err.message || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '초기화 실패';
            resolve({ ok: false, error: msg.trim() });
        });
    });
};

const probeEncoder = async (codec: TranscoderCodec): Promise<EncoderProbeResult> => {
    const cached = encoderProbeCache.get(codec);
    if (cached) return cached;

    const platform = os.platform();
    const osSupported = (ENCODER_OS_SUPPORT[codec] || []).includes(platform);
    if (!osSupported) {
        const res: EncoderProbeResult = { id: codec, available: false, osSupported: false, reason: '현재 OS에서 지원하지 않음' };
        encoderProbeCache.set(codec, res);
        return res;
    }

    if (codec === 'libx264') {
        const res: EncoderProbeResult = { id: codec, available: true, osSupported: true };
        encoderProbeCache.set(codec, res);
        return res;
    }

    const compiled = await getCompiledEncoders();
    if (!compiled.has(codec)) {
        const res: EncoderProbeResult = { id: codec, available: false, osSupported: true, reason: 'FFmpeg 빌드에 미포함' };
        encoderProbeCache.set(codec, res);
        return res;
    }

    const baseInput = ['-hide_banner', '-loglevel', 'error'];
    const testSource = ['-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1:r=10', '-frames:v', '1'];
    const nullOut = ['-f', 'null', '-'];

    let result: EncoderProbeResult;
    if (codec === 'h264_vaapi') {
        const devices = getLinuxRenderDevices();
        if (devices.length === 0) {
            result = { id: codec, available: false, osSupported: true, reason: '/dev/dri 렌더 장치를 찾을 수 없음' };
        } else {
            let lastError = 'VA-API 장치 초기화 실패';
            let matchedDevice: string | undefined;
            for (const dev of devices) {
                const probe = await runFfmpegProbe([
                    ...baseInput,
                    '-hwaccel', 'vaapi', '-hwaccel_device', dev,
                    ...testSource,
                    '-vf', 'format=nv12,hwupload',
                    '-c:v', 'h264_vaapi',
                    ...nullOut,
                ]);
                if (probe.ok) {
                    matchedDevice = dev;
                    detectedRenderDevices.h264_vaapi = dev;
                    break;
                }
                if (probe.error) lastError = probe.error;
            }
            result = matchedDevice
                ? { id: codec, available: true, osSupported: true, device: matchedDevice }
                : { id: codec, available: false, osSupported: true, reason: lastError };
        }
    } else if (codec === 'h264_qsv') {
        if (platform === 'linux') {
            const devices = getLinuxRenderDevices();
            if (devices.length === 0) {
                result = { id: codec, available: false, osSupported: true, reason: '/dev/dri 렌더 장치를 찾을 수 없음' };
            } else {
                let lastError = 'QSV 장치 초기화 실패';
                let matchedDevice: string | undefined;
                for (const dev of devices) {
                    const probe = await runFfmpegProbe([
                        ...baseInput,
                        '-qsv_device', dev,
                        ...testSource,
                        '-c:v', 'h264_qsv', '-pix_fmt', 'nv12', '-preset', 'veryfast',
                        ...nullOut,
                    ]);
                    if (probe.ok) {
                        matchedDevice = dev;
                        detectedRenderDevices.h264_qsv = dev;
                        break;
                    }
                    if (probe.error) lastError = probe.error;
                }
                result = matchedDevice
                    ? { id: codec, available: true, osSupported: true, device: matchedDevice }
                    : { id: codec, available: false, osSupported: true, reason: lastError };
            }
        } else {
            const probe = await runFfmpegProbe([
                ...baseInput,
                ...testSource,
                '-c:v', 'h264_qsv', '-pix_fmt', 'nv12', '-preset', 'veryfast',
                ...nullOut,
            ]);
            result = probe.ok
                ? { id: codec, available: true, osSupported: true }
                : { id: codec, available: false, osSupported: true, reason: probe.error || '하드웨어 미지원' };
        }
    } else if (codec === 'h264_nvenc') {
        const probe = await runFfmpegProbe([
            ...baseInput,
            ...testSource,
            '-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-preset', 'p1',
            ...nullOut,
        ]);
        result = probe.ok
            ? { id: codec, available: true, osSupported: true }
            : { id: codec, available: false, osSupported: true, reason: probe.error || 'NVIDIA GPU를 찾을 수 없음' };
    } else if (codec === 'h264_amf') {
        const probe = await runFfmpegProbe([
            ...baseInput,
            ...testSource,
            '-c:v', 'h264_amf', '-pix_fmt', 'yuv420p', '-quality', 'speed',
            ...nullOut,
        ]);
        result = probe.ok
            ? { id: codec, available: true, osSupported: true }
            : { id: codec, available: false, osSupported: true, reason: probe.error || 'AMD AMF 드라이버를 찾을 수 없음' };
    } else {
        result = { id: codec, available: false, osSupported: false, reason: '지원하지 않는 인코더' };
    }

    encoderProbeCache.set(codec, result);
    return result;
};

const probeAllEncoders = async (): Promise<EncoderProbeResult[]> => {
    if (probeAllInFlight) return probeAllInFlight;
    probeAllInFlight = Promise.all(SUPPORTED_ENCODERS.map(codec => probeEncoder(codec)))
        .finally(() => { probeAllInFlight = null; });
    return probeAllInFlight;
};

const checkEncoder = async (codec: string): Promise<boolean> => {
    if (codec === 'copy' || codec === 'libx264') return true;
    if (!SUPPORTED_ENCODERS.includes(codec as TranscoderCodec)) return false;
    const result = await probeEncoder(codec as TranscoderCodec);
    return result.available;
};

const parseResolution = (resolution: string | null) => {
    const [w, h] = resolution ? resolution.split('x').map(Number) : [1920, 1080];
    return { width: isNaN(w) ? 1920 : w, height: isNaN(h) ? 1080 : h };
};

const parseQualitySpec = (quality: string, originalHeight: number) => {
    const needsScale = quality !== 'original';
    let targetHeight = 0;
    let targetBitrate = '';
    let applyScaleFilter = needsScale;
    if (needsScale) {
        if (quality.includes('_')) {
            const [resPart, bitratePart] = quality.split('_');
            targetHeight = parseInt(resPart.replace('p', ''), 10);
            targetBitrate = bitratePart;
        } else {
            targetHeight = parseInt(quality.replace('p', ''), 10);
        }
        if (targetHeight === originalHeight) applyScaleFilter = false;
    }
    return { needsScale, targetHeight, targetBitrate, applyScaleFilter };
};

const getDirectPlayContentType = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mov') return 'video/quicktime';
    return 'video/mp4';
};

const getLatestGeneratedSeq = (outDir: string, fallbackSeq: number): number => {
    const dummyM3u8Path = path.join(outDir, 'dummy.m3u8');
    if (!fs.existsSync(dummyM3u8Path)) return fallbackSeq;
    try {
        const content = fs.readFileSync(dummyM3u8Path, 'utf8');
        const matches = [...content.matchAll(/stream(\d+)\.ts/g)];
        if (matches.length > 0) return parseInt(matches[matches.length - 1][1], 10);
    } catch (e) {}
    return fallbackSeq;
};

const cleanupStream = (id: string, quality?: string, deleteFiles: boolean = true): boolean => {
    let stoppedAny = false;
    const targetKeys = quality
        ? [getStreamKey(id, quality)]
        : Object.keys(activeStreams).filter(key => key.startsWith(`${id}_`));

    for (const key of targetKeys) {
        const stream = activeStreams[key];
        if (!stream) continue;
        if (stream.command) {
            if (!quality) console.log(`🛑 [ID: ${id}] 자원 확보를 위해 기존 인코더 프로세스 강제 종료: ${key}`);
            killEncoderProcess(stream.command);
            delete stream.command;
            stoppedAny = true;
        }
        stream.launching = false;
        if (deleteFiles) {
            clearTimeout(stream.timeout);
            delete activeStreams[key];
        }
    }

    if (deleteFiles) {
        const outDir = quality
            ? path.join(HLS_TEMP_DIR, id.toString(), quality)
            : path.join(HLS_TEMP_DIR, id.toString());
        fs.promises.rm(outDir, { recursive: true, force: true })
            .then(() => console.log(`🧹 [ID: ${id}] ${quality ? `${quality} 임시 HLS 파일` : `임시 HLS 파일 전체`} 정리 완료`))
            .catch(() => {});
    }
    return stoppedAny;
};

const touchStreamTimeout = (id: string, quality: string) => {
    const streamKey = getStreamKey(id, quality);
    if (!activeStreams[streamKey]) activeStreams[streamKey] = {};
    if (activeStreams[streamKey].timeout) clearTimeout(activeStreams[streamKey].timeout);
    activeStreams[streamKey].timeout = setTimeout(() => cleanupStream(id, quality), SESSION_TIMEOUT_MS);
};

const isSequentialSegmentRequest = (streamKey: string, seq: number, outDir: string): boolean => {
    const stream = activeStreams[streamKey];
    if (!stream?.command || stream.currentSeq === undefined) return true;
    const currentSeq = stream.currentSeq;
    const timeSinceStart = Date.now() - (stream.startTime || 0);

    // FFmpeg가 방금(3초 이내) 시작되었다면 동시에 들어온 Safari의 다중 요청일 가능성이 높으므로 킬하지 않음
    if (timeSinceStart < 3000 && seq >= currentSeq && seq <= currentSeq + 5) return true;
    if (seq < currentSeq) {
        // Edge/iOS Safari 네이티브 HLS 엔진이 화질 변경 직후 이전 시점을 한 번 더 요청하는 현상 보호
        return Boolean(stream.coldStart && timeSinceStart < 1500);
    }
    const latestSeq = getLatestGeneratedSeq(outDir, currentSeq);
    return seq <= latestSeq + 3;
};

// 원본 해상도를 분석하여 제공할 화질 목록을 계산하는 헬퍼 함수
const getAvailableQualities = (resolution: string | null) => {
    const { width: originalWidth, height: originalHeight } = parseResolution(resolution);
    const qualities = [{ name: 'original', label: `원본 (${originalHeight}p)`, height: originalHeight, width: originalWidth }];
    if (originalHeight >= 2160) {
        qualities.push({ name: '2160p_80M', label: '4K - 80 Mbps', height: 2160, width: 0 });
        qualities.push({ name: '2160p_40M', label: '4K - 40 Mbps', height: 2160, width: 0 });
    }
    if (originalHeight >= 1080) {
        qualities.push({ name: '1080p_20M', label: '1080p - 20 Mbps', height: 1080, width: 0 });
        qualities.push({ name: '1080p_10M', label: '1080p - 10 Mbps', height: 1080, width: 0 });
    }
    if (originalHeight >= 720) qualities.push({ name: '720p_4M', label: '720p - 4 Mbps', height: 720, width: 0 });
    if (originalHeight >= 480) qualities.push({ name: '480p_1.5M', label: '480p - 1.5 Mbps', height: 480, width: 0 });
    return qualities;
};

// ─── 설정 API ───
router.get('/config', (req, res) => {
    res.json(getConfig());
});

router.post('/config', async (req, res) => {
    const { mediaDir } = req.body;
    if (!mediaDir) return res.status(400).json({ error: '경로가 필요합니다.' });

    try {
        const resolvedPath = path.resolve(mediaDir);
        
        const currentConfig = getConfig();
        if (currentConfig && currentConfig.mediaDir) {
            if (path.resolve(currentConfig.mediaDir) === resolvedPath) {
                return res.json({ success: true, mediaDir: resolvedPath, unchanged: true });
            }
        }

        if (!fs.existsSync(resolvedPath)) {
            fs.mkdirSync(resolvedPath, { recursive: true });
        }
        await stopScanner();
        saveConfig({ mediaDir: resolvedPath });
        db.prepare('DELETE FROM videos').run();
        const THUMBNAIL_DIR = path.resolve(process.cwd(), 'public/thumbnails');
        if (fs.existsSync(THUMBNAIL_DIR)) {
            fs.readdirSync(THUMBNAIL_DIR).forEach(file => {
                const curPath = path.join(THUMBNAIL_DIR, file);
                fs.rmSync(curPath, { recursive: true, force: true });
            });
        }
        startScanner();
        res.json({ success: true, mediaDir: resolvedPath });
    } catch (err: any) {
        console.error('경로 변경 오류:', err);
        res.status(500).json({ error: '경로 변경 중 오류가 발생했습니다.', details: err.message });
    }
});

// ⚡ 시스템 폴더 브라우징 API (설정 모달용)
// ─── API: 시스템 하드웨어 및 트랜스코딩 설정 조회 ───
router.get('/settings/transcoder', async (req, res) => {
    let gpuInfo = '알 수 없는 하드웨어';
    try {
        if (os.platform() === 'win32') {
            const gpu = cp.execSync('powershell "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            if (gpu) {
                gpuInfo = gpu.split('\n')[0].trim();
            } else {
                const cpu = cp.execSync('powershell "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                if (cpu) gpuInfo = cpu;
            }
        } else if (os.platform() === 'linux') {
            try {
                const gpu = cp.execSync('lspci | grep -iE "vga|3d"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                if (gpu) {
                    const parts = gpu.split('\n')[0].split(':');
                    gpuInfo = parts[parts.length - 1].trim();
                }
            } catch (e) {}

            if (gpuInfo === '알 수 없는 하드웨어') {
                try {
                    const cpu = cp.execSync('grep -m 1 "model name" /proc/cpuinfo', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                    if (cpu) gpuInfo = cpu.split(':')[1].trim();
                } catch (e) {}
            }
        } else if (os.platform() === 'darwin') {
            try {
                const cpu = cp.execSync('sysctl -n machdep.cpu.brand_string', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                if (cpu) gpuInfo = cpu;
            } catch(e) {}
        }
    } catch (e) {}

    let codec = 'libx264';
    try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('transcoder_codec') as { value: string } | undefined;
        if (row) codec = row.value;
    } catch (e) {}

    const encoders = await probeAllEncoders();
    res.json({ gpu: gpuInfo, codec, platform: os.platform(), encoders });
});

// ─── API: 트랜스코딩 설정 업데이트 ───
router.put('/settings/transcoder', (req, res) => {
    const { codec } = req.body;
    if (!codec) return res.status(400).json({ error: '코덱 값이 없습니다.' });
    if (!SUPPORTED_ENCODERS.includes(codec as TranscoderCodec)) {
        return res.status(400).json({ error: '지원하지 않는 인코더 코덱입니다.' });
    }

    try {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run('transcoder_codec', codec, codec);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: '설정 저장 중 오류가 발생했습니다.' });
    }
});

// ─── API: FFmpeg 상태 및 버전 정보 조회 ───
router.get('/settings/ffmpeg', async (req, res) => {
    try {
        const current = getFfmpegInfo();
        const latest = await checkLatestRelease(false);
        const updateState = getUpdateState();
        res.json({ current, latest, updateState });
    } catch (e: any) {
        console.error('FFmpeg 정보 조회 실패:', e);
        res.status(500).json({ error: 'FFmpeg 정보를 불러오지 못했습니다.' });
    }
});

// ─── API: FFmpeg 최신 버전 강제 확인 ───
router.post('/settings/ffmpeg/check', async (req, res) => {
    try {
        const current = getFfmpegInfo();
        const latest = await checkLatestRelease(true);
        const updateState = getUpdateState();
        res.json({ current, latest, updateState });
    } catch (e: any) {
        console.error('FFmpeg 최신 버전 확인 실패:', e);
        res.status(500).json({ error: '최신 버전 정보를 확인하지 못했습니다.' });
    }
});

// ─── API: FFmpeg 업데이트 실행 ───
router.post('/settings/ffmpeg/update', async (req, res) => {
    try {
        const currentState = getUpdateState();
        if (currentState.isUpdating) {
            return res.status(409).json({ error: '이미 업데이트가 진행 중입니다.' });
        }

        // 비동기로 업데이트 진행 시작
        updateFfmpeg().catch(err => {
            console.error('FFmpeg 백그라운드 업데이트 오류:', err);
        });

        res.json({ success: true, message: 'FFmpeg 업데이트가 시작되었습니다.' });
    } catch (e: any) {
        console.error('FFmpeg 업데이트 시작 실패:', e);
        res.status(500).json({ error: e.message || '업데이트를 시작하지 못했습니다.' });
    }
});

// ─── API: FFmpeg 업데이트 진행 상태 조회 ───
router.get('/settings/ffmpeg/progress', (req, res) => {
    const state = getUpdateState();
    res.json(state);
});

router.get('/system-browse', (req, res) => {
    let targetPath = (req.query.path as string) || '';

    try {
        if (!targetPath) {
            if (os.platform() === 'win32') {
                let drives = ['C:'];
                try {
                    const stdout = cp.execSync('wmic logicaldisk get name', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                    const matched = stdout.match(/[A-Z]:/g);
                    if (matched) drives = matched;
                } catch (e) {
                    // wmic 오류 발생 시 기본 드라이브(C:)로 폴백
                }
                const folders = drives.map(d => ({
                    name: d + '\\',
                    path: d + '\\'
                }));
                return res.json({ currentPath: '', parentPath: null, folders });
            } else {
                // 리눅스/Mac의 경우 빈 경로일 때 홈 디렉토리부터 시작
                targetPath = os.homedir();
            }
        }

        const resolvedPath = path.resolve(targetPath);
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
            return res.status(404).json({ error: '경로를 찾을 수 없습니다.' });
        }

        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const folders = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('$') && !e.name.startsWith('System Volume Information'))
            .map(e => ({
                name: e.name,
                path: path.join(resolvedPath, e.name)
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        const parsed = path.parse(resolvedPath);
        const parentPath = (parsed.root === resolvedPath) ? '' : path.resolve(resolvedPath, '..');

        res.json({
            currentPath: resolvedPath,
            parentPath,
            folders
        });
    } catch (err: any) {
        console.error('System browse error:', err);
        // 권한 오류 등의 경우 빈 목록 반환
        res.json({
            currentPath: targetPath,
            parentPath: path.resolve(targetPath, '..'),
            folders: []
        });
    }
});

// ─── API 라우터 ───

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];

router.get('/videos', (req, res) => {
    const videos: any[] = db.prepare('SELECT * FROM videos ORDER BY id DESC').all();
    videos.forEach(video => {
        const hash = crypto.createHash('md5').update(video.id.toString()).digest('hex');
        const folderName = hash.substring(0, 2);
        video.thumbnail_url = `/thumbnails/${folderName}/${hash}.jpg`;
    });
    res.json(videos);
});

// ⚡ 폴더 브라우징 API
router.get('/browse', (req, res) => {
    const relativePath = (req.query.path as string) || '';
    const { mediaDir } = getConfig();

    // 경로 탐색 공격 방지
    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    const targetDir = path.resolve(mediaDir, normalizedPath);

    if (!targetDir.startsWith(mediaDir)) {
        return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
    }

    try {
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });

        // 폴더 목록
        const folders = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => {
                const folderPath = relativePath ? `${relativePath}/${e.name}` : e.name;
                const absoluteFolderPath = path.join(targetDir, e.name);
                
                // 해당 폴더(하위 포함) 내의 랜덤 비디오 1개 선택
                // LIKE 패턴을 위해 폴더 경로 끝에 구분자와 % 추가
                const pattern = absoluteFolderPath + path.sep + '%';
                const randomVideo = db.prepare('SELECT id FROM videos WHERE file_path LIKE ? ORDER BY RANDOM() LIMIT 1').get(pattern) as { id: number } | undefined;
                
                const typeCounts = db.prepare('SELECT type, COUNT(*) as count FROM videos WHERE file_path LIKE ? GROUP BY type').all(pattern) as { type: string, count: number }[];
                let videoCount = 0;
                let imageCount = 0;
                typeCounts.forEach(r => {
                    if (r.type === 'video') videoCount = r.count;
                    if (r.type === 'image') imageCount = r.count;
                });
                
                const agg = db.prepare('SELECT SUM(file_size) as total_size, MAX(duration) as max_duration FROM videos WHERE file_path LIKE ?').get(pattern) as { total_size: number | null, max_duration: number | null };
                
                const resRows = db.prepare("SELECT resolution FROM videos WHERE file_path LIKE ? AND type='video' AND resolution IS NOT NULL").all(pattern) as { resolution: string }[];
                let maxResValue = 0;
                for (const r of resRows) {
                    if (r.resolution && r.resolution !== 'unknown') {
                        const parts = r.resolution.split('x');
                        if (parts.length === 2) {
                            const val = parseInt(parts[0]) * parseInt(parts[1]);
                            if (val > maxResValue) maxResValue = val;
                        }
                    }
                }
                
                let thumbnail_url = undefined;
                if (randomVideo) {
                    const hash = crypto.createHash('md5').update(randomVideo.id.toString()).digest('hex');
                    const hashFolder = hash.substring(0, 2);
                    thumbnail_url = `/thumbnails/${hashFolder}/${hash}.jpg`;
                }

                return {
                    name: e.name,
                    path: folderPath,
                    thumbnail_url,
                    videoCount,
                    imageCount,
                    total_size: agg.total_size || 0,
                    max_duration: agg.max_duration || 0,
                    max_resolution_value: maxResValue
                };
            });

        // 현재 폴더 내 미디어 파일 (DB에서 조회)
        const videos: any[] = [];
        entries
            .filter(e => e.isFile() && MEDIA_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
            .forEach(e => {
                const fullPath = path.join(targetDir, e.name);
                const video = db.prepare('SELECT * FROM videos WHERE file_path = ?').get(fullPath) as VideoRecord | undefined;
                if (video) {
                    // 해싱 로직 적용하여 프론트엔드용 썸네일 URL 주입
                    const hash = crypto.createHash('md5').update(video.id.toString()).digest('hex');
                    const folderName = hash.substring(0, 2);
                    video.thumbnail_url = `/thumbnails/${folderName}/${hash}.jpg`;
                    videos.push(video);
                }
            });

        // 파일명 기준 정렬
        videos.sort((a: any, b: any) => a.file_name.localeCompare(b.file_name));

        res.json({
            currentPath: relativePath,
            parentPath: relativePath ? path.dirname(relativePath).replace(/^\./, '') : null,
            folders,
            videos,
        });
    } catch (err) {
        console.error('폴더 탐색 오류:', err);
        res.status(500).json({ error: '폴더 탐색 중 오류가 발생했습니다.' });
    }
});

// ⚡ 이미지 원본 제공 API
router.get('/image/:id', (req, res) => {
    const { id } = req.params;
    const media: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!media || !fs.existsSync(media.file_path) || media.type !== 'image') {
        return res.status(404).send('이미지를 찾을 수 없습니다.');
    }
    res.sendFile(media.file_path);
});

// ⚡ 화질 목록 API (프론트엔드 화질 메뉴에 사용)
router.get('/hls/:id/qualities', (req, res) => {
    const { id } = req.params;
    const video: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!video) return res.status(404).json({ error: '비디오를 찾을 수 없습니다.' });

    const qualities = getAvailableQualities(video.resolution);
    const container = video.container_format || '';
    const isDirectPlaySupported =
        ((container.includes('mp4') || container.includes('mov')) && video.video_codec === 'h264' && video.audio_codec === 'aac') ||
        (container.includes('webm') && (video.video_codec === 'vp8' || video.video_codec === 'vp9' || video.video_codec === 'av1'));

    res.json({ qualities, isDirectPlaySupported });
});

// ⚡ Direct Play 스트리밍 API (HTTP Range 206 지원)
router.get('/video/:id/direct', (req, res) => {
    const { id } = req.params;
    const video: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!video || !fs.existsSync(video.file_path)) return res.status(404).send('비디오를 찾을 수 없습니다.');

    const stoppedHls = cleanupStream(id, undefined, false);
    const fileSize = fs.statSync(video.file_path).size;
    const contentType = getDirectPlayContentType(video.file_path);
    const range = req.headers.range;

    let start = 0;
    let end = fileSize - 1;
    let statusCode = 200;

    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.sendStatus(416);
        }
        start = match[1] ? parseInt(match[1], 10) : 0;
        end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;
        if (isNaN(start) || isNaN(end) || start < 0 || start >= fileSize || start > end) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.sendStatus(416);
        }
        statusCode = 206;
    }

    if (stoppedHls || start === 0) {
        console.log(`⚡ Direct Play (원본) 스트리밍 시작: 비디오 ID ${id}`);
    }

    const headers: Record<string, string | number> = {
        'Accept-Ranges': 'bytes',
        'Content-Length': (end - start) + 1,
        'Content-Type': contentType,
    };
    if (statusCode === 206) headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;

    res.writeHead(statusCode, headers);
    const fileStream = statusCode === 206
        ? fs.createReadStream(video.file_path, { start, end })
        : fs.createReadStream(video.file_path);

    res.on('close', () => { if (!fileStream.destroyed) fileStream.destroy(); });
    fileStream.on('error', (err) => {
        console.error('Direct Play 스트림 읽기 오류:', err.message);
        if (!res.headersSent) res.sendStatus(500);
        else res.end();
    });
    fileStream.pipe(res);
});

// 스트리밍 명시적 종료 API (비디오 플레이어를 닫을 때 호출)
router.post('/hls/:id/stop', (req, res) => {
    const { id } = req.params;
    if (cleanupStream(id, undefined, false)) {
        console.log(`[종료 요청] 비디오 ID: ${id} 인코딩 중지 (임시 폴더는 유지)`);
    }
    res.sendStatus(200);
});

// 화질별 HLS 플레이리스트
router.get('/hls/:id/:quality/index.m3u8', (req, res) => {
    const { id, quality } = req.params;
    const video: any = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!video || !video.duration) return res.status(404).send('비디오를 찾을 수 없습니다.');

    const outDir = path.join(HLS_TEMP_DIR, id.toString(), quality);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const streamKey = getStreamKey(id, quality);
    for (const key of Object.keys(activeStreams)) {
        if (key.startsWith(`${id}_`) && key !== streamKey && activeStreams[key]?.command) {
            console.log(`[화질 변경 감지] 자원 확보를 위해 기존 인코딩 강제 종료: ${key}`);
            cleanupStream(id, key.substring(id.toString().length + 1), false);
        }
    }

    touchStreamTimeout(id, quality);

    const totalSegments = Math.ceil(video.duration / SEGMENT_TIME);
    let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n";
    m3u8 += `#EXT-X-TARGETDURATION:${SEGMENT_TIME}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;

    const startTimeParam = parseFloat((req.query.startTime as string) || '');
    if (!isNaN(startTimeParam) && startTimeParam > 0 && startTimeParam < video.duration) {
        m3u8 += `#EXT-X-START:TIME-OFFSET=${startTimeParam.toFixed(3)}\n`;
    }

    for (let i = 0; i < totalSegments; i++) {
        const chunkDuration = (i === totalSegments - 1 && video.duration % SEGMENT_TIME !== 0)
            ? video.duration % SEGMENT_TIME : SEGMENT_TIME;
        m3u8 += `#EXTINF:${chunkDuration.toFixed(6)},\nstream${i}.ts\n`;
    }
    m3u8 += "#EXT-X-ENDLIST\n";

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(m3u8);
});

// TS 조각 파일 생성 라우터
router.get('/hls/:id/:quality/:file', async (req, res) => {
    const { id, quality, file } = req.params;
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRecord | undefined;
    if (!video) return res.status(404).send('비디오를 찾을 수 없습니다.');

    const seqMatch = file.match(/^stream(\d+)\.ts$/);
    if (!seqMatch) return res.status(400).send('잘못된 요청입니다.');
    const seq = parseInt(seqMatch[1], 10);

    const outDir = path.join(HLS_TEMP_DIR, id.toString(), quality);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, file);

    const streamKey = getStreamKey(id, quality);
    touchStreamTimeout(id, quality);

    if (!fs.existsSync(filePath)) {
        const isSequential = isSequentialSegmentRequest(streamKey, seq, outDir);

        if (!isSequential && activeStreams[streamKey]?.command) {
            console.log(`🚀 탐색 감지됨: 기존 인코더 종료 및 seq=${seq} 부터 재시작`);
            killEncoderProcess(activeStreams[streamKey].command);
            delete activeStreams[streamKey].command;
            activeStreams[streamKey].launching = false;
            activeStreams[streamKey].coldStart = false;

            const dummyM3u8Path = path.join(outDir, 'dummy.m3u8');
            if (fs.existsSync(dummyM3u8Path)) {
                try { fs.unlinkSync(dummyM3u8Path); } catch (e) {}
            }
        }

        if (!activeStreams[streamKey]?.command && !activeStreams[streamKey]?.launching) {
            activeStreams[streamKey].coldStart = activeStreams[streamKey].currentSeq === undefined;
            activeStreams[streamKey].launching = true;

            try {
                const startTime = seq * SEGMENT_TIME;
                console.log(`🎬 [ID: ${id}] ${quality} 화질 인코딩 시작 (seq=${seq}, time=${startTime}s)`);

                const { width: originalWidth, height: originalHeight } = parseResolution(video.resolution);
                const { needsScale, targetHeight, targetBitrate, applyScaleFilter } = parseQualitySpec(quality, originalHeight);

                let vCodec = 'libx264';
                try {
                    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('transcoder_codec') as { value: string } | undefined;
                    if (row && row.value) vCodec = row.value;
                } catch (e) {}

                if (!(await checkEncoder(vCodec))) {
                    console.warn(`⚠️ [ID: ${id}] ${quality} 화질 인코딩 중 선택된 인코더(${vCodec})를 지원하지 않아 libx264로 자동 전환합니다.`);
                    vCodec = 'libx264';
                }

                const isHardwareEncoder = vCodec !== 'libx264' && vCodec !== 'copy';
                if (isHardwareEncoder && (originalWidth > 4096 || originalHeight > 2160)) {
                    console.log(`⚠️ [ID: ${id}] 해상도(${video.resolution})가 하드웨어 인코더(${vCodec}) 한계를 초과하여 libx264로 자동 하향합니다.`);
                    vCodec = 'libx264';
                }

                let aCodec = 'aac';
                if (!needsScale && video.video_codec === 'h264' && video.audio_codec === 'aac') {
                    vCodec = 'copy';
                    aCodec = 'copy';
                }

                const launchEncoder = (targetVCodec: string, allowFallback: boolean) => {
                    const inputOptions = ['-threads', '0'];
                    if (video.video_codec === 'av1' || video.video_codec === 'av01') inputOptions.push('-c:v', 'libdav1d');

                    if (targetVCodec === 'h264_vaapi') {
                        const renderDevice = detectedRenderDevices.h264_vaapi || getLinuxRenderDevices()[0] || '/dev/dri/renderD128';
                        inputOptions.push('-hwaccel', 'vaapi', '-hwaccel_device', renderDevice);
                    } else if (targetVCodec === 'h264_qsv' && os.platform() === 'linux') {
                        const renderDevice = detectedRenderDevices.h264_qsv || getLinuxRenderDevices()[0] || '/dev/dri/renderD128';
                        inputOptions.push('-qsv_device', renderDevice);
                    }
                    inputOptions.push('-ss', String(startTime));

                    const outputOptions = [
                        '-threads', '0',
                        '-c:v', targetVCodec,
                        '-c:a', aCodec,
                        '-start_number', String(seq),
                        '-hls_time', String(SEGMENT_TIME),
                        '-hls_list_size', '0',
                        '-hls_flags', 'independent_segments+temp_file',
                        '-hls_segment_filename', path.join(outDir, 'stream%d.ts'),
                        '-f', 'hls',
                        '-output_ts_offset', String(startTime),
                    ];

                    if (targetVCodec === 'h264_qsv') outputOptions.push('-pix_fmt', 'nv12');
                    else if (targetVCodec !== 'copy' && targetVCodec !== 'h264_vaapi') outputOptions.push('-pix_fmt', 'yuv420p');

                    if (targetVCodec === 'h264_vaapi') {
                        outputOptions.push('-vf', applyScaleFilter ? `format=nv12,hwupload,scale_vaapi=w=-2:h=${targetHeight}` : 'format=nv12,hwupload');
                    } else if (applyScaleFilter) {
                        outputOptions.push('-vf', `scale=-2:${targetHeight}`);
                    }

                    if (targetBitrate && targetVCodec !== 'copy') {
                        outputOptions.push('-b:v', targetBitrate, '-maxrate', targetBitrate);
                        const bitVal = parseInt(targetBitrate.replace('M', ''), 10);
                        if (!isNaN(bitVal)) outputOptions.push('-bufsize', `${bitVal * 2}M`);
                    }

                    if (targetVCodec === 'libx264') outputOptions.push('-preset', 'ultrafast');
                    else if (targetVCodec === 'h264_nvenc') outputOptions.push('-preset', 'p1');
                    else if (targetVCodec === 'h264_qsv') outputOptions.push('-preset', 'veryfast');
                    else if (targetVCodec === 'h264_amf') outputOptions.push('-quality', 'speed');

                    if (targetVCodec !== 'copy') {
                        outputOptions.push('-g', '60', '-sc_threshold', '0', '-flags', '+cgop', '-force_key_frames', `expr:gte(t,${startTime}+n_forced*${SEGMENT_TIME})`);
                        if (targetVCodec === 'libx264') outputOptions.push('-profile:v', 'high');
                    }

                    const ffmpegBin = getFfmpegPath();
                    const args = [
                        '-hide_banner',
                        '-y',
                        ...inputOptions,
                        '-i', video.file_path,
                        ...outputOptions,
                        path.join(outDir, 'dummy.m3u8'),
                    ];

                    const proc = cp.spawn(ffmpegBin, args, {
                        stdio: ['ignore', 'ignore', 'pipe'],
                        windowsHide: true,
                    });

                    console.log(`✅ [${quality}] 실행 명령어:`, `${ffmpegBin} ${args.join(' ')}`);

                    let lastStderrLine = '';
                    proc.stderr?.on('data', (chunk: Buffer) => {
                        const text = chunk.toString();
                        for (const line of text.split(/\r?\n/)) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;
                            lastStderrLine = trimmed;
                            const lower = trimmed.toLowerCase();
                            if (lower.includes('error') && !lower.includes('configuration:') && !lower.includes('hwaccel initialisation returned error')) {
                                console.error(`❌ [${quality}] FFmpeg 에러:`, trimmed);
                            }
                        }
                    });

                    const handleFailure = (reason: string, isKilled: boolean) => {
                        if (!isKilled) console.error(`❌ [${quality}] 인코딩 실패 (${targetVCodec}):`, reason);
                        if (activeStreams[streamKey]?.command === proc) {
                            delete activeStreams[streamKey].command;
                            if (!isKilled && allowFallback && targetVCodec !== 'libx264' && targetVCodec !== 'copy' && !fs.existsSync(filePath)) {
                                console.warn(`⚠️ [ID: ${id}] 하드웨어 인코더(${targetVCodec}) 런타임 실패로 libx264로 자동 폴백합니다.`);
                                launchEncoder('libx264', false);
                            }
                        }
                    };

                    proc.on('error', (err) => handleFailure(err.message, killedProcesses.has(proc)));
                    proc.on('close', (code, signal) => {
                        if (code === 0) {
                            if (activeStreams[streamKey]?.command === proc) delete activeStreams[streamKey].command;
                            console.log(`✅ [ID: ${id}] ${quality} 전체 인코딩 완료`);
                        } else {
                            const isKilled = killedProcesses.has(proc) || signal === 'SIGKILL';
                            handleFailure(lastStderrLine || `exit code ${code} (signal: ${signal || 'none'})`, isKilled);
                        }
                    });

                    activeStreams[streamKey].command = proc;
                    activeStreams[streamKey].currentSeq = seq;
                    activeStreams[streamKey].startTime = Date.now();
                    activeStreams[streamKey].launching = false;
                };

                launchEncoder(vCodec, true);
            } catch (launchErr) {
                if (activeStreams[streamKey]) activeStreams[streamKey].launching = false;
                throw launchErr;
            }
        }
    }

    const isSegmentReady = (): boolean => {
        if (!fs.existsSync(filePath)) return false;
        const stream = activeStreams[streamKey];
        if (!stream?.command) return true;
        if (stream.currentSeq !== undefined && seq < stream.currentSeq) return true;
        const dummyM3u8Path = path.join(outDir, 'dummy.m3u8');
        if (!fs.existsSync(dummyM3u8Path)) return false;
        try {
            return fs.readFileSync(dummyM3u8Path, 'utf8').includes(file);
        } catch (e) {
            return false;
        }
    };

    const sendSegment = () => {
        if (res.headersSent || res.writableEnded) return;
        res.setHeader('Content-Type', 'video/MP2T');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.sendFile(filePath);
    };

    if (isSegmentReady()) return sendSegment();

    let attempts = 0;
    const maxAttempts = 300; // 300 * 100ms = 30초 대기
    const checkFileExists = setInterval(() => {
        if (isSegmentReady()) {
            clearInterval(checkFileExists);
            sendSegment();
        } else if (++attempts >= maxAttempts) {
            clearInterval(checkFileExists);
            if (!res.headersSent && !res.writableEnded) res.status(500).send('스트리밍 준비 시간 초과');
        }
    }, 100);

    // 클라이언트 연결 종료 시 즉시 폴링 타이머 해제 (불필요한 디스크 I/O 누수 방지)
    req.on('close', () => clearInterval(checkFileExists));
});

// ⚡ 속도 측정용 더미 다운로드 API
router.get('/speedtest/download', (req, res) => {
    // 50MB 크기 전송
    const size = 50 * 1024 * 1024;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', size.toString());
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // 네트워크 레벨의 압축(gzip 등)을 방지하기 위해 랜덤 바이트 1MB 버퍼 생성
    const crypto = require('crypto');
    const randomBuffer = crypto.randomBytes(1024 * 1024);
    
    let bytesWritten = 0;
    const writeData = () => {
        let ok = true;
        while (bytesWritten < size && ok) {
            const toWrite = Math.min(randomBuffer.length, size - bytesWritten);
            ok = res.write(randomBuffer.slice(0, toWrite));
            bytesWritten += toWrite;
        }
        if (bytesWritten < size) {
            res.once('drain', writeData);
        } else {
            res.end();
        }
    };
    writeData();
});

export default router;
