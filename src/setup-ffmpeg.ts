import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import https from 'https';

const FFMPEG_DIR = path.resolve(process.cwd(), 'ffmpeg');
const VERSION_FILE = path.join(FFMPEG_DIR, 'version.json');

let resolvedFfmpegPath: string | null = null;
let resolvedFfprobePath: string | null = null;

export interface FfmpegInfo {
    installed: boolean;
    version: string;
    tag?: string;
    path: string;
    isSystem: boolean;
    sourceType: 'system' | 'local' | 'none';
    sourceLabel: string;
    platform: string;
    rawVersion?: string;
}

export interface FfmpegLatestInfo {
    latestVersion: string;
    releaseTag: string;
    releaseName: string;
    publishedAt: string;
    downloadUrl: string | null;
    assetName: string | null;
    hasUpdate: boolean;
}

export interface FfmpegUpdateState {
    isUpdating: boolean;
    step: 'idle' | 'checking' | 'downloading' | 'extracting' | 'installing' | 'completed' | 'error';
    percent: number;
    message: string;
    error?: string;
}

let updateState: FfmpegUpdateState = {
    isUpdating: false,
    step: 'idle',
    percent: 0,
    message: '대기 중'
};

export const getUpdateState = (): FfmpegUpdateState => {
    return { ...updateState };
};

export const getFfmpegPath = (): string => {
    if (resolvedFfmpegPath) return resolvedFfmpegPath;

    const ext = os.platform() === 'win32' ? '.exe' : '';
    const localPath = path.join(FFMPEG_DIR, `ffmpeg${ext}`);
    if (fs.existsSync(localPath)) return localPath;

    if (os.platform() !== 'win32') {
        const systemJellyfin = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/jellyfin-ffmpeg'];
        for (const p of systemJellyfin) {
            if (fs.existsSync(p)) return p;
        }
    }
    return localPath;
};

export const getFfprobePath = (): string => {
    if (resolvedFfprobePath) return resolvedFfprobePath;

    const ext = os.platform() === 'win32' ? '.exe' : '';
    const localPath = path.join(FFMPEG_DIR, `ffprobe${ext}`);
    if (fs.existsSync(localPath)) return localPath;

    if (os.platform() !== 'win32') {
        const systemJellyfin = ['/usr/lib/jellyfin-ffmpeg/ffprobe', '/usr/bin/jellyfin-ffprobe'];
        for (const p of systemJellyfin) {
            if (fs.existsSync(p)) return p;
        }
    }
    return localPath;
};

// 재귀적 파일 검색 헬퍼
const findFileRecursive = (dir: string, fileName: string): string | null => {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileRecursive(fullPath, fileName);
            if (found) return found;
        } else if (entry.name === fileName) {
            return fullPath;
        }
    }
    return null;
};

const downloadFileWithProgress = (
    url: string,
    dest: string,
    onProgress?: (percent: number, loaded: number, total: number) => void
): Promise<void> => {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : require('http');
        const req = client.get(url, {
            headers: { 'User-Agent': 'LightMediaBox' }
        }, (response: any) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                let redirectUrl = response.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const parsedUrl = new URL(url);
                    redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                }
                return downloadFileWithProgress(redirectUrl, dest, onProgress).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                reject(new Error(`다운로드 실패: HTTP ${response.statusCode}`));
                return;
            }

            const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
            let loadedBytes = 0;

            const file = fs.createWriteStream(dest);
            response.on('data', (chunk: Buffer) => {
                loadedBytes += chunk.length;
                if (totalBytes > 0 && onProgress) {
                    const pct = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
                    onProgress(pct, loadedBytes, totalBytes);
                }
            });

            response.pipe(file);
            file.on('finish', () => {
                file.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            file.on('error', (err) => {
                file.close();
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
                reject(err);
            });
        });

        req.on('error', (err: any) => {
            reject(err);
        });
    });
};

const downloadFile = (url: string, dest: string): Promise<void> => {
    return downloadFileWithProgress(url, dest);
};

// 현재 설치된 FFmpeg 정보 확인
export const getFfmpegInfo = (): FfmpegInfo => {
    const ffmpegPath = getFfmpegPath();
    const installed = fs.existsSync(ffmpegPath);
    const platform = os.platform();

    if (!installed) {
        return {
            installed: false,
            version: '미설치',
            path: ffmpegPath,
            isSystem: false,
            sourceType: 'none',
            sourceLabel: '미설치',
            platform
        };
    }

    const isSystem = platform !== 'win32' && ffmpegPath.startsWith('/usr');
    const sourceType: 'system' | 'local' | 'none' = isSystem ? 'system' : 'local';
    const sourceLabel = isSystem
        ? '시스템 패키지 매니저 (APT 등)'
        : 'LightMediaBox 직접 다운로드 (포터블)';

    // 1. version.json 확인 (LightMediaBox 자체 다운로드인 경우)
    if (!isSystem && fs.existsSync(VERSION_FILE)) {
        try {
            const meta = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'));
            if (meta && meta.version) {
                return {
                    installed: true,
                    version: meta.version,
                    tag: meta.tag || `v${meta.version}`,
                    path: ffmpegPath,
                    isSystem,
                    sourceType,
                    sourceLabel,
                    platform
                };
            }
        } catch (e) { }
    }

    // 2. 바이너리 직접 실행하여 버전 파싱
    let rawVersion = '';
    let parsedVersion = '알 수 없음';
    try {
        const out = execSync(`"${ffmpegPath}" -version`, {
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000
        }).toString();
        const firstLine = out.split('\n')[0].trim();
        rawVersion = firstLine;

        // 예: "ffmpeg version 8.1.2-Jellyfin Copyright (c)..."
        const match = firstLine.match(/ffmpeg version ([^\s]+)/i);
        if (match && match[1]) {
            parsedVersion = match[1];
        }

        // 기존 8.1.2-2 설치본 보정
        if (!isSystem && (parsedVersion === '8.1.2-Jellyfin' || parsedVersion.startsWith('8.1.2'))) {
            // 저장된 version.json이 없을 때 기존 초기값 매핑
            parsedVersion = '8.1.2-2';
            try {
                fs.writeFileSync(VERSION_FILE, JSON.stringify({
                    version: '8.1.2-2',
                    tag: 'v8.1.2-2',
                    installedAt: new Date().toISOString()
                }, null, 2));
            } catch (e) { }
        }
    } catch (e) {
        console.warn('ffmpeg 버전 확인 실패:', e);
    }

    return {
        installed: true,
        version: parsedVersion,
        tag: `v${parsedVersion}`,
        path: ffmpegPath,
        isSystem,
        sourceType,
        sourceLabel,
        platform,
        rawVersion
    };
};

// 최신 릴리스 정보 캐시 (10분)
let latestCache: { info: FfmpegLatestInfo; timestamp: number } | null = null;

// 플랫폼/아키텍처에 맞는 에셋 매칭
const findMatchingAsset = (assets: any[]): { downloadUrl: string; assetName: string } | null => {
    const platform = os.platform();
    const arch = os.arch();

    let targetPattern = '';
    if (platform === 'win32') {
        targetPattern = arch === 'arm64' ? 'portable_winarm64' : 'portable_win64';
    } else if (platform === 'linux') {
        targetPattern = arch === 'arm64' ? 'portable_linuxarm64' : 'portable_linux64';
    } else if (platform === 'darwin') {
        targetPattern = arch === 'arm64' ? 'portable_macarm64' : 'portable_mac64';
    } else {
        return null;
    }

    const matched = assets.find((a: any) => a.name && a.name.includes(targetPattern));
    if (matched) {
        return {
            downloadUrl: matched.browser_download_url,
            assetName: matched.name
        };
    }
    return null;
};

// 최신 Jellyfin-FFmpeg 릴리스 확인
export const checkLatestRelease = async (force: boolean = false): Promise<FfmpegLatestInfo> => {
    const now = Date.now();
    if (!force && latestCache && (now - latestCache.timestamp < 10 * 60 * 1000)) {
        return latestCache.info;
    }

    const currentInfo = getFfmpegInfo();

    try {
        const res = await fetch('https://api.github.com/repos/jellyfin/jellyfin-ffmpeg/releases/latest', {
            headers: {
                'User-Agent': 'LightMediaBox'
            }
        });

        if (res.ok) {
            const data: any = await res.json();
            const releaseTag = data.tag_name || '';
            const latestVersion = releaseTag.replace(/^v/, '');
            const releaseName = data.name || releaseTag;
            const publishedAt = data.published_at || '';

            const asset = findMatchingAsset(data.assets || []);
            const hasUpdate = Boolean(
                currentInfo.installed &&
                latestVersion &&
                currentInfo.version !== latestVersion &&
                currentInfo.version.replace(/^v/, '') !== latestVersion
            );

            const result: FfmpegLatestInfo = {
                latestVersion,
                releaseTag,
                releaseName,
                publishedAt,
                downloadUrl: asset ? asset.downloadUrl : null,
                assetName: asset ? asset.assetName : null,
                hasUpdate
            };

            latestCache = { info: result, timestamp: now };
            return result;
        }
    } catch (err) {
        console.warn('GitHub API 확인 실패, 미러 확인 시도:', err);
    }

    // GitHub API 실패 시 repo.jellyfin.org 미러 체크 폴백
    try {
        const platform = os.platform();
        let fallbackUrl = '';
        if (platform === 'win32') {
            fallbackUrl = 'https://repo.jellyfin.org/files/ffmpeg/windows/latest-8.x/win64/';
        } else if (platform === 'linux') {
            fallbackUrl = 'https://repo.jellyfin.org/files/ffmpeg/linux/latest-8.x/amd64/';
        }

        if (fallbackUrl) {
            const res = await fetch(fallbackUrl);
            if (res.ok) {
                const html = await res.text();
                const match = html.match(/jellyfin-ffmpeg_([0-9\.\-]+)_portable[^\"]+/i);
                if (match) {
                    const assetName = match[0];
                    const version = match[1];
                    const downloadUrl = `${fallbackUrl}${assetName}`;
                    const hasUpdate = currentInfo.installed && currentInfo.version !== version;

                    const result: FfmpegLatestInfo = {
                        latestVersion: version,
                        releaseTag: `v${version}`,
                        releaseName: `Release ${version}`,
                        publishedAt: new Date().toISOString(),
                        downloadUrl,
                        assetName,
                        hasUpdate
                    };

                    latestCache = { info: result, timestamp: now };
                    return result;
                }
            }
        }
    } catch (err) {
        console.warn('미러 확인 실패:', err);
    }

    // 최종 실패 시
    const fallbackResult: FfmpegLatestInfo = {
        latestVersion: currentInfo.version || '알 수 없음',
        releaseTag: currentInfo.tag || '',
        releaseName: '조회 실패',
        publishedAt: '',
        downloadUrl: null,
        assetName: null,
        hasUpdate: false
    };
    return fallbackResult;
};

// FFmpeg 업데이트 실행
export const updateFfmpeg = async (): Promise<{ success: boolean; message: string; version?: string }> => {
    if (updateState.isUpdating) {
        throw new Error('이미 업데이트가 진행 중입니다.');
    }

    const platform = os.platform();
    const ext = platform === 'win32' ? '.exe' : '';
    const ffmpegBinName = `ffmpeg${ext}`;
    const ffprobeBinName = `ffprobe${ext}`;

    const localFfmpeg = path.join(FFMPEG_DIR, ffmpegBinName);
    const localFfprobe = path.join(FFMPEG_DIR, ffprobeBinName);

    try {
        updateState = {
            isUpdating: true,
            step: 'checking',
            percent: 5,
            message: '최신 릴리스 정보 확인 중...'
        };

        const latest = await checkLatestRelease(true);
        if (!latest.downloadUrl) {
            throw new Error('현재 환경에 적합한 Jellyfin-FFmpeg 다운로드 파일을 찾을 수 없습니다.');
        }

        updateState = {
            isUpdating: true,
            step: 'downloading',
            percent: 10,
            message: `Jellyfin-FFmpeg ${latest.latestVersion} 다운로드 시작...`
        };

        if (!fs.existsSync(FFMPEG_DIR)) fs.mkdirSync(FFMPEG_DIR, { recursive: true });

        const isZip = latest.downloadUrl.endsWith('.zip');
        const archiveExt = isZip ? '.zip' : '.tar.xz';
        const archivePath = path.join(process.cwd(), `jellyfin-ffmpeg-update${archiveExt}`);
        const extractTempPath = path.join(process.cwd(), 'ffmpeg-temp-update');

        if (fs.existsSync(extractTempPath)) {
            fs.rmSync(extractTempPath, { recursive: true, force: true });
        }
        fs.mkdirSync(extractTempPath, { recursive: true });

        // 다운로드 진행률 (10% ~ 75%)
        await downloadFileWithProgress(latest.downloadUrl, archivePath, (pct) => {
            const scaledPct = Math.round(10 + (pct * 0.65));
            updateState = {
                isUpdating: true,
                step: 'downloading',
                percent: scaledPct,
                message: `다운로드 중... (${pct}%)`
            };
        });

        // 압축 해제 (75% ~ 90%)
        updateState = {
            isUpdating: true,
            step: 'extracting',
            percent: 80,
            message: '압축 파일 해제 중...'
        };

        if (isZip) {
            execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractTempPath}' -Force"`, {
                stdio: 'ignore'
            });
        } else {
            execSync(`tar -xf "${archivePath}" -C "${extractTempPath}"`, {
                stdio: 'ignore'
            });
        }

        // 바이너리 파일 교체 (90% ~ 100%)
        updateState = {
            isUpdating: true,
            step: 'installing',
            percent: 90,
            message: '바이너리 파일 교체 중...'
        };

        const foundFfmpeg = findFileRecursive(extractTempPath, ffmpegBinName);
        const foundFfprobe = findFileRecursive(extractTempPath, ffprobeBinName);

        if (!foundFfmpeg || !foundFfprobe) {
            throw new Error('압축 파일 내에서 ffmpeg 또는 ffprobe 바이너리를 찾을 수 없습니다.');
        }

        // Windows 파일 락 방지용 백업 및 교체
        const backupFfmpeg = `${localFfmpeg}.bak`;
        const backupFfprobe = `${localFfprobe}.bak`;

        try {
            if (fs.existsSync(backupFfmpeg)) fs.unlinkSync(backupFfmpeg);
            if (fs.existsSync(backupFfprobe)) fs.unlinkSync(backupFfprobe);

            if (fs.existsSync(localFfmpeg)) fs.renameSync(localFfmpeg, backupFfmpeg);
            if (fs.existsSync(localFfprobe)) fs.renameSync(localFfprobe, backupFfprobe);

            fs.copyFileSync(foundFfmpeg, localFfmpeg);
            fs.copyFileSync(foundFfprobe, localFfprobe);

            if (platform !== 'win32') {
                fs.chmodSync(localFfmpeg, 0o755);
                fs.chmodSync(localFfprobe, 0o755);
            }

            // 백업 파일 제거
            if (fs.existsSync(backupFfmpeg)) fs.unlinkSync(backupFfmpeg);
            if (fs.existsSync(backupFfprobe)) fs.unlinkSync(backupFfprobe);
        } catch (copyErr) {
            // 복구 시도
            if (!fs.existsSync(localFfmpeg) && fs.existsSync(backupFfmpeg)) {
                fs.renameSync(backupFfmpeg, localFfmpeg);
            }
            if (!fs.existsSync(localFfprobe) && fs.existsSync(backupFfprobe)) {
                fs.renameSync(backupFfprobe, localFfprobe);
            }
            throw copyErr;
        }

        // 메타데이터 저장
        fs.writeFileSync(VERSION_FILE, JSON.stringify({
            version: latest.latestVersion,
            tag: latest.releaseTag,
            releaseName: latest.releaseName,
            updatedAt: new Date().toISOString(),
            assetName: latest.assetName,
            downloadUrl: latest.downloadUrl
        }, null, 2));

        // 경로 재갱신
        resolvedFfmpegPath = localFfmpeg;
        resolvedFfprobePath = localFfprobe;

        try {
            const fluentFfmpeg = require('fluent-ffmpeg');
            fluentFfmpeg.setFfmpegPath(localFfmpeg);
            fluentFfmpeg.setFfprobePath(localFfprobe);
        } catch (e) { }

        // 임시 정리
        if (fs.existsSync(extractTempPath)) fs.rmSync(extractTempPath, { recursive: true, force: true });
        if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);

        // 캐시 무효화
        latestCache = null;

        updateState = {
            isUpdating: false,
            step: 'completed',
            percent: 100,
            message: `성공적으로 v${latest.latestVersion} 버전으로 업데이트되었습니다.`
        };

        return {
            success: true,
            message: updateState.message,
            version: latest.latestVersion
        };
    } catch (err: any) {
        updateState = {
            isUpdating: false,
            step: 'error',
            percent: 0,
            message: '업데이트 중 오류가 발생했습니다.',
            error: err.message || String(err)
        };
        throw err;
    }
};

export const setupFfmpeg = async () => {
    const platform = os.platform();
    const ext = platform === 'win32' ? '.exe' : '';
    const ffmpegBinName = `ffmpeg${ext}`;
    const ffprobeBinName = `ffprobe${ext}`;

    const localFfmpeg = path.join(FFMPEG_DIR, ffmpegBinName);
    const localFfprobe = path.join(FFMPEG_DIR, ffprobeBinName);

    // 1. 이미 다운로드된 로컬 jellyfin-ffmpeg 확인
    if (fs.existsSync(localFfmpeg) && fs.existsSync(localFfprobe)) {
        console.log('✅ 로컬 jellyfin-ffmpeg 및 ffprobe를 사용합니다.');
        resolvedFfmpegPath = localFfmpeg;
        resolvedFfprobePath = localFfprobe;
        getFfmpegInfo(); // version.json 생성 유도
        return;
    }

    // 2. Linux 시스템 패키지로 설치된 jellyfin-ffmpeg 확인
    if (platform !== 'win32') {
        const systemJellyfinFfmpegPaths = ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/jellyfin-ffmpeg'];
        const systemJellyfinFfprobePaths = ['/usr/lib/jellyfin-ffmpeg/ffprobe', '/usr/bin/jellyfin-ffprobe'];

        for (let i = 0; i < systemJellyfinFfmpegPaths.length; i++) {
            const ffmpegP = systemJellyfinFfmpegPaths[i];
            const ffprobeP = systemJellyfinFfprobePaths[i];
            if (fs.existsSync(ffmpegP) && fs.existsSync(ffprobeP)) {
                console.log(`🚀 시스템 최적화 jellyfin-ffmpeg 인코더를 사용합니다. (${ffmpegP})`);
                resolvedFfmpegPath = ffmpegP;
                resolvedFfprobePath = ffprobeP;
                return;
            }
        }
    }

    // 3. 로컬/시스템에 jellyfin-ffmpeg가 없으면 100% 최신 포터블 바이너리를 다운로드
    console.log(`⬇️ jellyfin-ffmpeg 최적화 포터블 인코더를 다운로드 중입니다... (${platform})`);

    if (!fs.existsSync(FFMPEG_DIR)) fs.mkdirSync(FFMPEG_DIR, { recursive: true });
    const extractTempPath = path.join(process.cwd(), 'ffmpeg-temp');
    if (!fs.existsSync(extractTempPath)) fs.mkdirSync(extractTempPath, { recursive: true });

    let latest: FfmpegLatestInfo | null = null;
    try {
        latest = await checkLatestRelease(true);
    } catch (e) { }

    if (platform === 'win32') {
        const zipUrl = (latest && latest.downloadUrl) ? latest.downloadUrl : 'https://repo.jellyfin.org/files/ffmpeg/windows/latest-8.x/win64/jellyfin-ffmpeg_8.1.2-5_portable_win64-clang-gpl.zip';
        const zipPath = path.join(process.cwd(), 'jellyfin-ffmpeg-release.zip');

        await downloadFile(zipUrl, zipPath);

        console.log('📦 jellyfin-ffmpeg 압축을 해제하는 중입니다...');
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTempPath}' -Force"`, { stdio: 'inherit' });

        const foundFfmpeg = findFileRecursive(extractTempPath, 'ffmpeg.exe');
        const foundFfprobe = findFileRecursive(extractTempPath, 'ffprobe.exe');

        if (foundFfmpeg && foundFfprobe) {
            fs.copyFileSync(foundFfmpeg, localFfmpeg);
            fs.copyFileSync(foundFfprobe, localFfprobe);

            const v = (latest && latest.latestVersion) ? latest.latestVersion : '8.1.2-5';
            fs.writeFileSync(VERSION_FILE, JSON.stringify({
                version: v,
                tag: `v${v}`,
                installedAt: new Date().toISOString()
            }, null, 2));
        } else {
            throw new Error('jellyfin-ffmpeg 바이너리를 추출하지 못했습니다.');
        }

        // Cleanup
        fs.rmSync(extractTempPath, { recursive: true, force: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } else {
        // Linux / macOS
        const tarUrl = (latest && latest.downloadUrl) ? latest.downloadUrl : 'https://repo.jellyfin.org/files/ffmpeg/linux/latest-8.x/amd64/jellyfin-ffmpeg_8.1.2-5_portable_linux64-gpl.tar.xz';
        const tarPath = path.join(process.cwd(), 'jellyfin-ffmpeg-release.tar.xz');

        await downloadFile(tarUrl, tarPath);

        console.log(`📦 jellyfin-ffmpeg (${platform}) 압축을 해제하는 중입니다...`);
        execSync(`tar -xf "${tarPath}" -C "${extractTempPath}"`, { stdio: 'inherit' });

        const foundFfmpeg = findFileRecursive(extractTempPath, 'ffmpeg');
        const foundFfprobe = findFileRecursive(extractTempPath, 'ffprobe');

        if (foundFfmpeg && foundFfprobe) {
            fs.copyFileSync(foundFfmpeg, localFfmpeg);
            fs.copyFileSync(foundFfprobe, localFfprobe);
            fs.chmodSync(localFfmpeg, 0o755);
            fs.chmodSync(localFfprobe, 0o755);

            const v = (latest && latest.latestVersion) ? latest.latestVersion : '8.1.2-5';
            fs.writeFileSync(VERSION_FILE, JSON.stringify({
                version: v,
                tag: `v${v}`,
                installedAt: new Date().toISOString()
            }, null, 2));
        } else {
            throw new Error('jellyfin-ffmpeg 바이너리를 추출하지 못했습니다.');
        }

        // Cleanup
        fs.rmSync(extractTempPath, { recursive: true, force: true });
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
    }

    resolvedFfmpegPath = localFfmpeg;
    resolvedFfprobePath = localFfprobe;
    console.log('🚀 jellyfin-ffmpeg 최적화 인코더 설치가 완료되었습니다.');
};
