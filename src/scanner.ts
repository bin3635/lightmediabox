import { watch, FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFfmpegPath, getFfprobePath } from './setup-ffmpeg';
import db from './db';
import crypto from 'crypto';
import { getConfig } from './config';

const execFileAsync = promisify(execFile);

const THUMBNAIL_DIR = path.resolve(process.cwd(), 'public/thumbnails');

// 폴더가 없으면 생성
if (!fs.existsSync(THUMBNAIL_DIR)) fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

let watcher: FSWatcher | null = null;

// 비디오 및 이미지 파일 확장자 필터
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];

class TaskQueue {
    private queue: (() => Promise<void>)[] = [];
    private running = 0;
    private concurrency: number;

    constructor(concurrency: number) {
        this.concurrency = concurrency;
    }

    add(task: () => Promise<void>) {
        this.queue.push(task);
        this.next();
    }

    private next() {
        if (this.running >= this.concurrency || this.queue.length === 0) {
            return;
        }
        const task = this.queue.shift();
        if (task) {
            this.running++;
            task().finally(() => {
                this.running--;
                this.next();
            });
        }
    }
}

const scannerQueue = new TaskQueue(4);

/**
 * ID 기반 썸네일 해시 경로 생성기
 */
export const getThumbnailPath = (id: number | string) => {
    const hash = crypto.createHash('md5').update(id.toString()).digest('hex');
    const folderName = hash.substring(0, 2);
    const fileName = `${hash}.jpg`;

    return {
        url: `/thumbnails/${folderName}/${fileName}`,
        folderPath: path.join(THUMBNAIL_DIR, folderName),
        absolutePath: path.join(THUMBNAIL_DIR, folderName, fileName),
    };
};

/**
 * FFprobe를 사용하여 메타데이터 추출 (Duration 등)
 */
const extractMetadata = async (filePath: string): Promise<any> => {
    try {
        const { stdout } = await execFileAsync(
            getFfprobePath(),
            ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
            { timeout: 30000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
        );
        const metadata = JSON.parse(stdout || '{}');
        const streams: any[] = Array.isArray(metadata.streams) ? metadata.streams : [];
        const format: any = metadata.format || {};

        const videoStream = streams.find((s) => s.codec_type === 'video');
        const audioStream = streams.find((s) => s.codec_type === 'audio');
        const parsedDuration = parseFloat(format.duration);
        const parsedSize = parseInt(format.size, 10);
        const duration = isNaN(parsedDuration) ? 0 : parsedDuration;
        const size = isNaN(parsedSize) ? 0 : parsedSize;
        const container = format.format_name || path.extname(filePath).replace('.', '');

        if (!videoStream) {
            return {
                duration,
                size,
                container,
                videoCodec: 'unknown',
                audioCodec: audioStream?.codec_name || 'none',
                resolution: 'unknown',
            };
        }

        return {
            duration,
            size,
            container,
            videoCodec: videoStream.codec_name || 'unknown',
            audioCodec: audioStream?.codec_name || 'none',
            resolution: videoStream.width && videoStream.height ? `${videoStream.width}x${videoStream.height}` : 'unknown',
        };
    } catch (err: any) {
        const firstLine = (err?.stderr || err?.message || String(err)).split(/\r?\n/)[0];
        console.warn(`⚠️ 메타데이터 추출 실패 (강제 등록됨): ${path.basename(filePath)} - ${firstLine}`);
        let size = 0;
        try { size = fs.statSync(filePath).size; } catch (e) { }
        return {
            duration: 0,
            size,
            container: path.extname(filePath).replace('.', ''),
            videoCodec: 'unknown',
            audioCodec: 'unknown',
            resolution: 'unknown',
        };
    }
};

/**
 * FFmpeg를 사용하여 영상의 10% 지점에서 썸네일 생성
 */
const generateThumbnail = async (filePath: string, id: number | bigint, videoCodec?: string, duration?: number): Promise<void> => {
    const thumbInfo = getThumbnailPath(id.toString());

    if (!fs.existsSync(thumbInfo.folderPath)) {
        fs.mkdirSync(thumbInfo.folderPath, { recursive: true });
    }

    if (fs.existsSync(thumbInfo.absolutePath)) {
        const stats = fs.statSync(thumbInfo.absolutePath);
        if (stats.size > 0) return;
        // 서버 강제 종료 등으로 인해 생성되다 만 0바이트 파일 삭제 후 재시도
        fs.unlinkSync(thumbInfo.absolutePath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.includes(ext);
    const tmpPath = thumbInfo.absolutePath.replace(/\.jpg$/, '_tmp.jpg');

    const runThumbFfmpeg = async (args: string[]) => {
        await execFileAsync(getFfmpegPath(), args, { timeout: 30000, windowsHide: true });
    };

    try {
        if (isImage) {
            await runThumbFfmpeg([
                '-hide_banner', '-loglevel', 'error', '-y',
                '-i', filePath,
                '-vf', 'scale=480:-1',
                '-frames:v', '1',
                tmpPath,
            ]);
        } else {
            const seekSec = duration && duration > 0 ? Math.max(0, duration * 0.1) : 0;
            const buildVideoArgs = (seek: number) => {
                const args = ['-hide_banner', '-loglevel', 'error', '-y'];
                if (seek > 0) args.push('-ss', seek.toFixed(3));
                if (videoCodec === 'av1' || videoCodec === 'av01') args.push('-c:v', 'libdav1d');
                args.push(
                    '-i', filePath,
                    '-vf', 'scale=480:-2',
                    '-pix_fmt', 'yuvj420p',
                    '-frames:v', '1',
                    '-q:v', '3',
                    tmpPath
                );
                return args;
            };

            await runThumbFfmpeg(buildVideoArgs(seekSec));
            // 짧은 영상 등에서 10% 지점 탐색 시 프레임이 추출되지 않으면 0초 지점으로 1회 재시도
            if (seekSec > 0 && (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0)) {
                await runThumbFfmpeg(buildVideoArgs(0));
            }
        }

        if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
            fs.renameSync(tmpPath, thumbInfo.absolutePath);
            console.log(`🖼️ 썸네일 생성 완료 (${isImage ? '이미지' : '비디오'}): ${thumbInfo.url}`);
        } else {
            throw new Error('썸네일 파일이 생성되지 않았습니다.');
        }
    } catch (err: any) {
        const errMsg = (err?.stderr || err?.message || String(err)).trim().split(/\r?\n/)[0];
        console.error(`❌ 썸네일 생성 실패 (${isImage ? '이미지' : '비디오'}, ${filePath}):`, errMsg);
        if (fs.existsSync(tmpPath)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
        }
        throw err;
    }
};

/**
 * 기존 비디오 썸네일 일괄 생성 및 마이그레이션
 */
const generateMissingThumbnails = async () => {
    try {
        const videos = db.prepare('SELECT id, file_path, video_codec, duration FROM videos').all() as any[];
        for (const video of videos) {
            const thumbInfo = getThumbnailPath(video.id);

            // 기존 1.jpg 형태의 구 버전 파일이 있는지 확인 후 마이그레이션
            const legacyPath = path.join(THUMBNAIL_DIR, `${video.id}.jpg`);
            if (fs.existsSync(legacyPath)) {
                if (!fs.existsSync(thumbInfo.folderPath)) {
                    fs.mkdirSync(thumbInfo.folderPath, { recursive: true });
                }
                fs.renameSync(legacyPath, thumbInfo.absolutePath);
                console.log(`🔄 썸네일 마이그레이션 완료: ${video.id}.jpg -> ${thumbInfo.url}`);
            }

            if (!fs.existsSync(thumbInfo.absolutePath) && fs.existsSync(video.file_path)) {
                scannerQueue.add(() => generateThumbnail(video.file_path, video.id, video.video_codec, video.duration).catch(() => { }));
            }
        }
    } catch (err) {
        console.error('기존 썸네일 일괄 생성 오류:', err);
    }
};

/**
 * DB에 메타데이터 삽입
 */
const insertVideoStmt = db.prepare(`
  INSERT INTO videos (
    file_name, file_path, file_size, duration, 
    resolution, video_codec, audio_codec, container_format, type
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const startScanner = () => {
    const { mediaDir } = getConfig();
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

    // 서버 재시작 시 DB와 실제 파일 시스템 동기화 (Ghost 엔트리 제거)
    const allVideos = db.prepare('SELECT id, file_path FROM videos').all() as any[];
    for (const v of allVideos) {
        if (!fs.existsSync(v.file_path)) {
            console.log(`🗑️ 사라진 비디오 정리됨: ${path.basename(v.file_path)}`);
            db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
            const thumbInfo = getThumbnailPath(v.id);
            if (fs.existsSync(thumbInfo.absolutePath)) fs.unlinkSync(thumbInfo.absolutePath);
            const legacyPath = path.join(process.cwd(), 'public', 'thumbnails', `${v.id}.jpg`);
            if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
        }
    }

    console.log(`🔍 스캐너 시작: ${mediaDir} 폴더 감시 중...`);

    // 시작 시 기존 썸네일 검사(마이그레이션 포함)
    generateMissingThumbnails();

    // chokidar 옵션 설정
    watcher = watch(mediaDir, {
        ignored: /(^|[\/\\])\../, // 숨김 파일 무시
        persistent: true,
        awaitWriteFinish: { // 파일 복사가 완전히 끝난 후 이벤트 발생
            stabilityThreshold: 2000,
            pollInterval: 100,
        },
    });

    const processingFiles = new Set<string>();
    let isWatcherReady = false;
    let initialExistingCount = 0;

    watcher.on('ready', () => {
        isWatcherReady = true;
        if (initialExistingCount > 0) {
            console.log(`➡️ 기존에 존재하는 미디어 총 ${initialExistingCount}개 확인 완료`);
        }
        console.log('✅ 초기 스캔 완료. 이후 변경 사항을 감시합니다.');
    });

    watcher.on('add', async (filePath) => {
        const ext = path.extname(filePath).toLowerCase();

        if (MEDIA_EXTENSIONS.includes(ext)) {
            if (processingFiles.has(filePath)) return;

            // 큐에 넣기 전에 동기적으로 DB 존재 여부 확인 (ready 이벤트를 위해 정확한 카운트 측정)
            const existing: any = db.prepare('SELECT id, video_codec, duration FROM videos WHERE file_path = ?').get(filePath);
            if (existing) {
                if (!isWatcherReady) {
                    initialExistingCount++;
                } else {
                    console.log(`➡️ 기존에 존재하는 미디어: ${path.basename(filePath)}`);
                }
                // 썸네일 생성을 위한 큐 추가 (메인 큐 병목 방지를 위해 분리)
                scannerQueue.add(() => generateThumbnail(filePath, existing.id, existing.video_codec, existing.duration).catch(() => { }));
                return;
            }

            processingFiles.add(filePath);

            scannerQueue.add(async () => {
                try {
                    // 혹시 모를 중복 방지 한 번 더 확인
                    const doubleCheck: any = db.prepare('SELECT id FROM videos WHERE file_path = ?').get(filePath);
                    if (doubleCheck) return;

                    console.log(`🎬 새 미디어 감지됨: ${path.basename(filePath)}`);
                    const fileName = path.basename(filePath);
                    const metadata = await extractMetadata(filePath);
                    console.log(`✅ 메타데이터 추출 완료: ${fileName}`);

                    const mediaType = IMAGE_EXTENSIONS.includes(ext) ? 'image' : 'video';

                    // 트랜잭션으로 DB 삽입
                    const insert = db.transaction(() => {
                        return insertVideoStmt.run(
                            fileName,
                            filePath,
                            metadata.size || 0,
                            metadata.duration || 0,
                            metadata.resolution,
                            metadata.videoCodec,
                            metadata.audioCodec,
                            metadata.container,
                            mediaType
                        );
                    });

                    try {
                        const result = insert();
                        // 썸네일 생성 작업 큐에 추가
                        scannerQueue.add(() => generateThumbnail(filePath, result.lastInsertRowid, metadata.videoCodec, metadata.duration).catch(() => { }));
                    } catch (insertError: any) {
                        if (insertError.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                            console.log(`➡️ 이미 등록된 미디어 (중복 무시됨): ${fileName}`);
                        } else {
                            throw insertError;
                        }
                    }
                } catch (error) {
                    console.error(`❌ 메타데이터 추출/저장 실패 (${filePath}):`, error);
                } finally {
                    processingFiles.delete(filePath);
                }
            });
        }
    });

    watcher.on('unlink', (filePath) => {
        const ext = path.extname(filePath).toLowerCase();

        if (MEDIA_EXTENSIONS.includes(ext)) {
            console.log(`🗑️ 미디어 삭제 감지됨: ${path.basename(filePath)}`);

            // DB에서 해당 파일 레코드 찾기
            const existing: any = db.prepare('SELECT id FROM videos WHERE file_path = ?').get(filePath);

            if (existing) {
                // DB에서 레코드 삭제
                db.prepare('DELETE FROM videos WHERE id = ?').run(existing.id);
                console.log(`✅ DB에서 삭제 완료: ${path.basename(filePath)}`);

                // 썸네일 새 로직 변경(해싱 경로 지정)
                const thumbInfo = getThumbnailPath(existing.id);
                if (fs.existsSync(thumbInfo.absolutePath)) {
                    fs.unlinkSync(thumbInfo.absolutePath);
                }

                // 기존 레거시 파일 혹시 남아있으면 삭제
                const legacyPath = path.join(THUMBNAIL_DIR, `${existing.id}.jpg`);
                if (fs.existsSync(legacyPath)) {
                    fs.unlinkSync(legacyPath);
                }
            }
        }
    });
};

export const stopScanner = async () => {
    if (watcher) {
        await watcher.close();
        watcher = null;
        console.log('?? ��ĳ�� ���ð� �����Ǿ����ϴ�.');
    }
};
