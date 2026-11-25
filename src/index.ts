import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import './db'; // 임포트하는 순간 내부의 db.exec()가 실행되어 테이블이 생성됨
import { startScanner } from './scanner';
import routes from './routes';
import authRoutes from './auth';
import db from './db';
import jwt from 'jsonwebtoken';

import { setupFfmpeg } from './setup-ffmpeg';

const SqliteStore = require('better-sqlite3-session-store')(session);

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // express-rate-limit 프록시 헤더 신뢰
app.use(express.json()); // JSON 바디 파싱을 위해 추가

app.use(session({
    store: new SqliteStore({
        client: db,
        expired: {
            clear: true,
            intervalMs: 15 * 60 * 1000
        }
    }),
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        sameSite: 'lax',
    }
}));

// API Auth 라우터 등록
app.use('/api/auth', authRoutes);

// API 보안 미들웨어 (인증되지 않은 요청 차단)
app.use('/api', (req, res, next) => {
    if (process.env.NODE_ENV === 'development' || req.session.userId) {
        return next();
    }

    const token = req.query.token as string;
    if (token) {
        try {
            const secret = process.env.SESSION_SECRET || 'default_secret_key';
            jwt.verify(token, secret);
            return next();
        } catch (err) {
            return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
        }
    }

    return res.status(401).json({ error: '인증이 필요합니다.' });
});

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const assetHashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();
let cachedIndexHtml: { mtimeMs: number; size: number; content: string } | null = null;

const getAssetHash = (fileName: string): string => {
    try {
        const filePath = path.join(PUBLIC_DIR, fileName);
        const stat = fs.statSync(filePath);
        const cached = assetHashCache.get(fileName);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.hash;
        }
        const hash = crypto
            .createHash('sha256')
            .update(fs.readFileSync(filePath))
            .digest('hex')
            .slice(0, 8);
        assetHashCache.set(fileName, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
        return hash;
    } catch {
        return '0';
    }
};

const getIndexHtmlWithAssetHashes = (): string => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    const stat = fs.statSync(indexPath);
    if (!cachedIndexHtml || cachedIndexHtml.mtimeMs !== stat.mtimeMs || cachedIndexHtml.size !== stat.size) {
        cachedIndexHtml = { mtimeMs: stat.mtimeMs, size: stat.size, content: fs.readFileSync(indexPath, 'utf8') };
    }
    const cssHash = getAssetHash('styles.css');
    const jsHash = getAssetHash('main.js');
    return cachedIndexHtml.content
        .replace(/href="styles\.css(?:\?v=[^"]*)?"/, `href="styles.css?v=${cssHash}"`)
        .replace(/src="main\.js(?:\?v=[^"]*)?"/, `src="main.js?v=${jsHash}"`);
};

// index.html은 항상 최신 상태로 서빙하면서 main.js / styles.css의 실제 파일 내용 해시를
// ?v=<hash>로 자동 주입한다. 내용이 바뀔 때만 URL이 자동으로 달라지므로 수동 버전 관리 없이도
// iOS Safari 등에서 안전하게 영구 캐시(immutable)와 즉시 업데이트를 동시에 달성할 수 있다.
app.get(['/', '/index.html'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(getIndexHtmlWithAssetHashes());
});

app.use(express.static(PUBLIC_DIR, {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('main.js') || filePath.endsWith('styles.css')) {
            const hasVersionQuery = Boolean(res.req?.url && res.req.url.includes('?v='));
            res.setHeader(
                'Cache-Control',
                hasVersionQuery ? 'public, max-age=31536000, immutable' : 'no-cache'
            );
        }
    }
}));

// 일반 API 라우터 등록
app.use('/api', routes);

// ffmpeg 설정 후 서버 시작
setupFfmpeg().then(() => {
    // 스캐너 실행
    startScanner();

    app.listen(PORT, () => {
        console.log(`🚀 미디어 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    });
}).catch(err => {
    console.error('❌ ffmpeg 초기화 실패:', err);
    process.exit(1);
});
