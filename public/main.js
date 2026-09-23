// ─── 전역 커스텀 UI ───
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showCustomDialog(options) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('custom-dialog');
        const title = document.getElementById('dialog-title');
        const message = document.getElementById('dialog-message');
        const input = document.getElementById('dialog-input');
        const btnCancel = document.getElementById('btn-dialog-cancel');
        const btnConfirm = document.getElementById('btn-dialog-confirm');

        title.textContent = options.title || '알림';
        message.textContent = options.message || '';

        if (options.type === 'prompt') {
            input.style.display = 'block';
            input.value = options.defaultValue || '';
            input.focus();
            
            if (options.requireMatch) {
                btnConfirm.disabled = true;
                input.oninput = () => {
                    btnConfirm.disabled = input.value !== options.requireMatch;
                };
            } else {
                btnConfirm.disabled = false;
                input.oninput = null;
            }
        } else {
            input.style.display = 'none';
            btnConfirm.disabled = false;
        }

        dialog.classList.add('visible');

        const cleanup = () => {
            dialog.classList.remove('visible');
            btnCancel.onclick = null;
            btnConfirm.onclick = null;
            input.oninput = null;
            btnConfirm.disabled = false;
        };

        btnCancel.onclick = () => {
            cleanup();
            resolve(options.type === 'prompt' ? null : false);
        };

        btnConfirm.onclick = () => {
            cleanup();
            resolve(options.type === 'prompt' ? input.value : true);
        };
    });
}

const showConfirm = (title, message) => showCustomDialog({ type: 'confirm', title, message });
const showPrompt = (title, message, defaultValue) => showCustomDialog({ type: 'prompt', title, message, defaultValue });

// ─── DOM 요소 ───
const libraryView = document.getElementById('library-view');
const libraryGrid = document.getElementById('library-grid');
const btnBackFolder = document.getElementById('btn-back');
const currentPathEl = document.getElementById('current-path');

const playerView = document.getElementById('player-view');
const btnClosePlayer = document.getElementById('btn-close-player');

const videoPlayer = document.getElementById('video-player');
const playerWrapper = document.getElementById('player-wrapper');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const centerPlay = document.getElementById('center-play');
const btnLogout = document.getElementById('btn-logout');

const progressContainer = document.getElementById('progress-container');
const progressPlayed = document.getElementById('progress-played');
const progressBuffered = document.getElementById('progress-buffered');
const progressThumb = document.getElementById('progress-thumb');

const btnPlay = document.getElementById('btn-play');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');

const btnMute = document.getElementById('btn-mute');
const iconVol = document.getElementById('icon-vol');
const iconMuted = document.getElementById('icon-muted');
const volumeSlider = document.getElementById('volume-slider');

const timeDisplay = document.getElementById('time-display');

const btnQuality = document.getElementById('btn-quality');
const qualityMenu = document.getElementById('quality-menu');

const btnRepeat = document.getElementById('btn-repeat');

const btnFullscreen = document.getElementById('btn-fullscreen');
const btnPip = document.getElementById('btn-pip');
const iconFsEnter = document.getElementById('icon-fs-enter');
const iconFsExit = document.getElementById('icon-fs-exit');

const imageViewer = document.getElementById('image-viewer');
const btnCloseImage = document.getElementById('btn-close-image');
const btnPrevImage = document.getElementById('btn-prev-image');
const btnNextImage = document.getElementById('btn-next-image');
const viewerImg = document.getElementById('viewer-img');
const imageIndexText = document.getElementById('image-index-text');
const imageTitleText = document.getElementById('image-title-text');

// ─── 주요 상태 및 변수 ───
let hls = null;
let currentVideoId = null;
let currentQuality = null;
let qualities = [];
let isDirectPlaySupported = false;
// 화질을 연달아 빠르게 전환하면, 이전 loadQuality() 호출의 canplay/loadedmetadata
// 리스너가 아직 안 끝난 채로 새 호출이 시작될 수 있음. 리스너를 addEventListener로만
// 등록하면 이전 것이 제거되지 않고 남아있다가 나중에 발동해 오래된(stale) savedTime을
// 잘못 적용하는 문제가 있었음. 매 loadQuality() 호출마다 토큰을 새로 발급하고, 콜백
// 실행 시점에 자신의 토큰이 최신인지 확인해 오래된 콜백을 무시하도록 한다.
let qualityLoadToken = 0;
let controlsTimeout = null;
let isSeeking = false;
let currentBrowsePath = '';
let isPlayerMode = false;
let isImageViewerMode = false;
let isRepeat = false;
let currentImages = [];
let currentImageIndex = -1;

let currentViewMode = 'folder'; // 'folder' | 'video'
let currentSortBy = 'name'; // 'name' | 'duration' | 'size' | 'resolution'
let currentSortOrder = 'asc'; // 'asc' | 'desc'
let lastLoadedData = { folders: [], videos: [] };

let currentRenderLimit = 50;
const RENDER_CHUNK_SIZE = 50;
let intersectionObserver = null;
let imageObserver = null;
let cachedSortedVideos = [];

if (window.IntersectionObserver) {
    intersectionObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            loadMoreItems();
        }
    }, { rootMargin: '200px' });

    imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                if (img.dataset.src) {
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                }
                observer.unobserve(img);
            }
        });
    }, { rootMargin: '300px' });
}

const tabFolder = document.getElementById('tab-folder');
const tabVideo = document.getElementById('tab-video');
const sortSelect = document.getElementById('sort-select');
const btnSortOrder = document.getElementById('btn-sort-order');
const iconAsc = document.querySelector('.icon-asc');
const iconDesc = document.querySelector('.icon-desc');

// ─── 뷰 전환 로직 ───
function showLibrary() {
    isPlayerMode = false;
    document.body.classList.remove('player-mode');
    // 플레이어 초기화 및 백그라운드 인코딩 즉시 종료
    if (hls) {
        hls.destroy();
        hls = null;
    }
    if (currentVideoId) {
        fetch(`/api/hls/${currentVideoId}/stop`, { method: 'POST' }).catch(() => {});
    }
    currentVideoId = null;
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();

    playerView.classList.remove('visible');
    playerView.classList.add('hidden');
    if (imageViewer) imageViewer.classList.add('hidden');
    libraryView.classList.remove('hidden');

    const history = viewHistory[getHistoryKey()];
    if (history && history.scroll) {
        setTimeout(() => {
            window.scrollTo({ top: history.scroll, behavior: 'instant' });
        }, 0);
    }

    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => { });
    }
}

// 브라우저 탭 종료, 새로고침, 뒤로가기 시 인코딩 즉시 종료 처리
window.addEventListener('beforeunload', () => {
    if (currentVideoId) {
        navigator.sendBeacon(`/api/hls/${currentVideoId}/stop`);
    }
});

function showPlayer() {
    saveCurrentHistory();
    isPlayerMode = true;
    document.body.classList.add('player-mode');
    libraryView.classList.add('hidden');
    playerView.classList.remove('hidden');
    playerView.classList.add('visible');
}

btnClosePlayer.onclick = showLibrary;

// ─── 정렬 헬퍼 ───
function getResolutionValue(resStr) {
    if (!resStr) return 0;
    const match = resStr.match(/(\d+)x(\d+)/);
    if (match) return parseInt(match[2], 10);
    return 0;
}

function sortItems(items, isFolder = false) {
    return [...items].sort((a, b) => {
        let valA, valB;

        if (currentSortBy === 'name') {
            valA = isFolder ? a.name.toLowerCase() : a.file_name.toLowerCase();
            valB = isFolder ? b.name.toLowerCase() : b.file_name.toLowerCase();
        } else if (currentSortBy === 'duration') {
            valA = isFolder ? (a.max_duration || 0) : (a.type === 'image' ? -1 : (a.duration || 0));
            valB = isFolder ? (b.max_duration || 0) : (b.type === 'image' ? -1 : (b.duration || 0));
        } else if (currentSortBy === 'size') {
            valA = isFolder ? (a.total_size || 0) : (a.file_size || 0);
            valB = isFolder ? (b.total_size || 0) : (b.file_size || 0);
        } else if (currentSortBy === 'resolution') {
            valA = isFolder ? (a.max_resolution_value || 0) : getResolutionValue(a.resolution);
            valB = isFolder ? (b.max_resolution_value || 0) : getResolutionValue(b.resolution);
        }

        if (valA < valB) return currentSortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return currentSortOrder === 'asc' ? 1 : -1;
        return 0;
    });
}

// ─── 화면 상태 복원 이력 ───
const viewHistory = {};

function getHistoryKey() {
    return currentViewMode === 'folder' ? `folder:${currentBrowsePath}` : 'videos';
}

function saveCurrentHistory() {
    viewHistory[getHistoryKey()] = {
        scroll: window.scrollY,
        limit: currentRenderLimit
    };
}

// ─── 데이터 로드 ───
async function loadLibrary() {
    libraryGrid.innerHTML = '<div class="empty-grid">불러오는 중...</div>';
    const pathBar = document.getElementById('path-bar');

    try {
        if (currentViewMode === 'folder') {
            pathBar.style.display = 'flex';
            if (currentBrowsePath) {
                btnBackFolder.style.display = 'flex';
                const parts = currentBrowsePath.split('/');
                currentPathEl.innerHTML = `📂 ${parts.join(' / ')}`;
            } else {
                btnBackFolder.style.display = 'none';
                currentPathEl.innerHTML = '📂 루트';
            }

            const res = await fetch(`/api/browse?path=${encodeURIComponent(currentBrowsePath)}`);
            if (res.status === 401) {
                checkAuthStatus();
                return;
            }
            lastLoadedData = await res.json();
        } else {
            pathBar.style.display = 'none';
            const res = await fetch(`/api/videos`);
            if (res.status === 401) {
                checkAuthStatus();
                return;
            }
            const allVideos = await res.json();
            lastLoadedData = { folders: [], videos: allVideos };
        }

        renderLibrary();
        hideLoading();
    } catch (err) {
        libraryGrid.innerHTML = '<div class="empty-grid">데이터를 불러올 수 없습니다.</div>';
        hideLoading();
    }
}

async function browsePath(targetPath) {
    saveCurrentHistory();
    currentBrowsePath = targetPath;
    currentViewMode = 'folder';
    updateTabsUI();

    const pathBar = document.getElementById('path-bar');
    pathBar.style.display = 'flex';
    if (currentBrowsePath) {
        btnBackFolder.style.display = 'flex';
        const parts = currentBrowsePath.split('/');
        currentPathEl.innerHTML = `📂 ${parts.join(' / ')}`;
    } else {
        btnBackFolder.style.display = 'none';
        currentPathEl.innerHTML = '📂 루트';
    }

    showLoading();
    try {
        const res = await fetch(`/api/browse?path=${encodeURIComponent(targetPath)}`);
        if (res.status === 401) {
            checkAuthStatus();
            return;
        }
        lastLoadedData = await res.json();
        renderLibrary();
        hideLoading();
    } catch (err) {
        libraryGrid.innerHTML = '<div class="empty-grid">데이터를 불러올 수 없습니다.</div>';
        hideLoading();
    }
}

// ─── 화면 렌더링 ───
function renderLibrary() {
    libraryGrid.innerHTML = '';
    const { folders, videos } = lastLoadedData;

    if (folders.length === 0 && videos.length === 0) {
        libraryGrid.innerHTML = '<div class="empty-grid">표시할 항목이 없습니다.</div>';
        return;
    }

    if (currentViewMode === 'folder') {
        // 폴더 카드
        const sortedFolders = sortItems(folders, true);
        sortedFolders.forEach(folder => {
            const card = document.createElement('div');
            card.className = 'media-card folder-card';

            let thumbHtml = '<div class="thumb-bg">📁</div>';

            if (folder.thumbnail_url) {
                const thumbUrl = folder.thumbnail_url + '?v=1';
                thumbHtml = `
                            <div class="fallback-icon">📁</div>
                            <div class="folder-badge">
                                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                                </svg>
                            </div>
                            <img class="thumb-bg lazy-image" data-src="${thumbUrl}" alt="folder-thumbnail" onerror="this.parentElement.classList.add('no-thumb');">
                        `;
            }

            let countsHtml = '';
            if (folder.videoCount > 0 || folder.imageCount > 0) {
                countsHtml = '<div class="folder-counts">';
                if (folder.videoCount > 0) {
                    countsHtml += `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg><span>${folder.videoCount}</span>`;
                }
                if (folder.imageCount > 0) {
                    countsHtml += `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg><span>${folder.imageCount}</span>`;
                }
                countsHtml += '</div>';
            }

            card.innerHTML = `
                        ${thumbHtml}
                        ${countsHtml}
                        <div class="card-info">
                            <div class="card-title">${folder.name}</div>
                        </div>
                    `;
            card.onclick = () => {
                browsePath(folder.path);
            };

            libraryGrid.appendChild(card);
            
            if (imageObserver) {
                const lazyImg = card.querySelector('.lazy-image');
                if (lazyImg) imageObserver.observe(lazyImg);
            }
        });
    }

    // 미디어 카드 (정렬 적용)
    cachedSortedVideos = sortItems(videos, false);
    currentImages = cachedSortedVideos.filter(v => v.type === 'image');
    const historyKey = getHistoryKey();
    const history = viewHistory[historyKey];

    currentRenderLimit = history ? history.limit : RENDER_CHUNK_SIZE;

    renderVideoChunk();

    if (history && history.scroll) {
        setTimeout(() => {
            window.scrollTo({ top: history.scroll, behavior: 'instant' });
        }, 0);
    } else {
        window.scrollTo({ top: 0, behavior: 'instant' });
    }
}

function renderVideoChunk() {
    const oldSentinel = document.getElementById('scroll-sentinel');
    if (oldSentinel) {
        if (intersectionObserver) intersectionObserver.unobserve(oldSentinel);
        oldSentinel.remove();
    }

    const currentCount = libraryGrid.querySelectorAll('.media-card.video-card, .media-card.image-card').length;
    const itemsToRender = cachedSortedVideos.slice(currentCount, currentRenderLimit);

    itemsToRender.forEach(video => {
        const card = document.createElement('div');
        card.className = `media-card ${video.type === 'image' ? 'image-card' : 'video-card'}`;

        let thumbHtml = `<div class="fallback-icon">${video.type === 'image' ? '🖼️' : '🎬'}</div>`;
        if (video.thumbnail_url) {
            thumbHtml += `<img class="thumb-bg lazy-image" data-src="${video.thumbnail_url}?v=1" alt="thumbnail" onerror="this.parentElement.classList.add('no-thumb');">`;
        } else {
            card.classList.add('no-thumb');
        }

        const durationHtml = video.type === 'image' ? '' : `<span>${formatTime(video.duration)}</span>`;
        const resHtml = video.resolution && video.resolution !== 'unknown' ? `<span>${video.resolution}</span>` : '';
        
        let bitrateHtml = '';
        if (video.type !== 'image' && video.file_size && video.duration > 0) {
            const mbps = ((video.file_size * 8) / video.duration / 1000000).toFixed(1);
            bitrateHtml = `<span>${mbps} Mbps</span>`;
        }

        card.innerHTML = `
                    ${thumbHtml}
                    <div class="card-info">
                        <div class="card-title">${video.file_name}</div>
                        <div class="card-meta">
                            ${durationHtml}
                            ${resHtml}
                            ${bitrateHtml}
                        </div>
                    </div>
                `;

        card.onclick = () => {
            if (video.type === 'image') {
                showImageViewer(video.id);
            } else {
                selectVideo(video.id);
            }
        };

        libraryGrid.appendChild(card);
        
        if (imageObserver) {
            const lazyImg = card.querySelector('.lazy-image');
            if (lazyImg) imageObserver.observe(lazyImg);
        }
    });

    if (currentRenderLimit < cachedSortedVideos.length) {
        const sentinel = document.createElement('div');
        sentinel.id = 'scroll-sentinel';
        sentinel.style.height = '1px';
        sentinel.style.width = '100%';
        sentinel.style.gridColumn = '1 / -1';
        libraryGrid.appendChild(sentinel);

        if (intersectionObserver) {
            intersectionObserver.observe(sentinel);
        }
    }
}

function loadMoreItems() {
    if (currentRenderLimit < cachedSortedVideos.length) {
        currentRenderLimit += RENDER_CHUNK_SIZE;
        renderVideoChunk();
    }
}

function updateTabsUI() {
    if (currentViewMode === 'folder') {
        tabFolder.classList.add('active');
        tabVideo.classList.remove('active');
    } else {
        tabVideo.classList.add('active');
        tabFolder.classList.remove('active');
    }
}

// ─── 상단 UI 이벤트 리스너 ───
tabFolder.onclick = () => {
    if (currentViewMode !== 'folder') {
        saveCurrentHistory();
        currentViewMode = 'folder';
        updateTabsUI();
        loadLibrary();
    }
};

tabVideo.onclick = () => {
    if (currentViewMode !== 'video') {
        saveCurrentHistory();
        currentViewMode = 'video';
        updateTabsUI();
        loadLibrary();
    }
};

sortSelect.onchange = (e) => {
    currentSortBy = e.target.value;
    renderLibrary();
};

btnSortOrder.onclick = () => {
    currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
    if (currentSortOrder === 'asc') {
        iconAsc.style.display = 'block';
        iconDesc.style.display = 'none';
    } else {
        iconAsc.style.display = 'none';
        iconDesc.style.display = 'block';
    }
    renderLibrary();
};

// 폴더 뒤로 가기
btnBackFolder.onclick = () => {
    if (!currentBrowsePath) return;
    const parent = currentBrowsePath.includes('/')
        ? currentBrowsePath.substring(0, currentBrowsePath.lastIndexOf('/'))
        : '';
    browsePath(parent);
};

// ─── 이미지 뷰어 로직 ───
function showImageViewer(id) {
    saveCurrentHistory();
    isImageViewerMode = true;
    document.body.classList.add('player-mode');
    libraryView.classList.add('hidden');
    if (imageViewer) imageViewer.classList.remove('hidden');

    currentImageIndex = currentImages.findIndex(img => img.id === id);
    if (currentImageIndex !== -1) {
        loadImage(currentImageIndex);
    }
}

function loadImage(index) {
    if (index < 0 || index >= currentImages.length) return;
    const imgData = currentImages[index];
    if (viewerImg) viewerImg.src = `/api/image/${imgData.id}?token=${window.streamToken || ''}`;
    if (imageIndexText) imageIndexText.textContent = `${index + 1} / ${currentImages.length}`;
    if (imageTitleText) imageTitleText.textContent = imgData.file_name;

    if (btnPrevImage) btnPrevImage.style.display = index > 0 ? 'flex' : 'none';
    if (btnNextImage) btnNextImage.style.display = index < currentImages.length - 1 ? 'flex' : 'none';
}

if (btnCloseImage) btnCloseImage.onclick = showLibrary;
if (btnPrevImage) {
    btnPrevImage.onclick = () => {
        if (currentImageIndex > 0) {
            currentImageIndex--;
            loadImage(currentImageIndex);
        }
    };
}
if (btnNextImage) {
    btnNextImage.onclick = () => {
        if (currentImageIndex < currentImages.length - 1) {
            currentImageIndex++;
            loadImage(currentImageIndex);
        }
    };
}

// ─── 영상 선택 및 재생 ───
async function selectVideo(id) {
    currentVideoId = id;
    showPlayer();

    // 화질 목록 로드
    const res = await fetch(`/api/hls/${id}/qualities`);
    const data = await res.json();
    qualities = data.qualities || [];
    isDirectPlaySupported = data.isDirectPlaySupported || false;

    // iOS Safari 등 모바일 환경에서 4K(2160p)를 초과하는 초고화질(6000p 등) 디코딩 시도시 프리징 발생 방지
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let defaultQuality = 'original';
    if (isIOS && qualities.length > 0 && qualities[0].height > 2160) {
        // 4K를 초과하는 경우 가장 높은 안전한 화질(예: 1080p)로 자동 하향
        const safeQuality = qualities.find(q => q.name !== 'original' && q.height <= 2160);
        if (safeQuality) {
            defaultQuality = safeQuality.name;
            console.log(`⚠️ iOS 기기에서 초고화질 재생 프리징을 방지하기 위해 기본 화질을 ${defaultQuality}로 하향합니다.`);
        }
    }

    loadQuality(defaultQuality);
}

// ─── 화질 로드 (수동 전환 핵심 로직) ───
function loadQuality(quality) {
    const myLoadToken = ++qualityLoadToken;
    const savedTime = videoPlayer.currentTime || 0;
    const wasPaused = videoPlayer.paused;

    currentQuality = quality;
    showLoading('화질 변환 중...');
    updateQualityMenu();

    // 기존 HLS 파괴
    if (hls) {
        hls.destroy();
        hls = null;
    }

    // 브라우저 비디오 디코더 완벽 초기화 (Safari 버그 방지)
    videoPlayer.removeAttribute('src');
    videoPlayer.load();

    // Direct Play 지원 여부에 따라 분기
    if (quality === 'original' && isDirectPlaySupported) {
        console.log('⚡ Direct Play 모드로 스트리밍 (TS 변환 없음)');
        videoPlayer.src = `/api/video/${currentVideoId}/direct?token=${window.streamToken || ''}`;
        if (savedTime > 0) {
            videoPlayer.currentTime = savedTime;
        }
        if (!wasPaused || savedTime === 0) {
            videoPlayer.play().catch(() => { });
        }

        // 실제 재생 가능해지면 로딩 해제
        const onCanPlay = () => {
            videoPlayer.removeEventListener('canplay', onCanPlay);
            if (myLoadToken !== qualityLoadToken) return; // 더 최신 화질 전환이 이미 시작됨
            hideLoading();
        };
        videoPlayer.addEventListener('canplay', onCanPlay);
        return;
    }

    // HLS 트랜스코딩 / 리먹싱 (Direct Play가 불가능하거나 480p 등을 선택한 경우)
    // startTime을 서버에 전달하면 플레이리스트에 #EXT-X-START가 포함되어, 플레이어가
    // 0초 세그먼트를 거쳐가지 않고 처음부터 재생 위치의 세그먼트를 요청하게 된다.
    const m3u8Url = `/api/hls/${currentVideoId}/${quality}/index.m3u8?token=${window.streamToken || ''}${savedTime > 0 ? `&startTime=${savedTime}` : ''}`;

    // Safari(Mac/iOS)의 경우 네이티브 HLS 지원이 훨씬 안정적이므로 최우선으로 사용합니다.
    if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
        videoPlayer.src = m3u8Url;
        videoPlayer.load();

        // load() 직후 currentTime을 지정하면 load()의 미디어 엘리먼트 초기화 과정에서
        // 재생 위치가 강제로 0으로 리셋되어버림(HTML5 스펙 동작). 그래서 반드시
        // load() 이후, 메타데이터가 준비된 시점(loadedmetadata/canplay)에 지정해야 함.
        // (예전 코드는 load() 호출 직전에 currentTime을 설정해서 항상 0으로 초기화된 뒤
        // 시작 → seq=0부터 인코딩이 시작되는 원인이었음. Windows Edge는 네이티브 HLS를
        // "maybe"로 지원하므로 이 브랜치를 탄다.)
        const onNativeCanPlay = () => {
            videoPlayer.removeEventListener('canplay', onNativeCanPlay);
            videoPlayer.removeEventListener('loadedmetadata', onNativeCanPlay);
            if (myLoadToken !== qualityLoadToken) return; // 더 최신 화질 전환이 이미 시작됨 — 오래된 savedTime 적용 방지
            hideLoading();
            if (savedTime > 0) {
                videoPlayer.currentTime = savedTime;
            }
            if (!wasPaused || savedTime === 0) {
                videoPlayer.play().catch(() => { });
            }
        };
        videoPlayer.addEventListener('canplay', onNativeCanPlay);
        videoPlayer.addEventListener('loadedmetadata', onNativeCanPlay);

    } else if (Hls.isSupported()) {
        hls = new Hls({
            startPosition: savedTime > 0 ? savedTime : -1,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferHole: 0.5,
            maxSeekHole: 2,
            enableWorker: true,
            lowLatencyMode: false,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
            levelLoadingTimeOut: 15000,
            levelLoadingMaxRetry: 4,
            startFragPrefetch: true,
        });
        hls.loadSource(m3u8Url);
        hls.attachMedia(videoPlayer);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (myLoadToken !== qualityLoadToken) return; // 더 최신 화질 전환이 이미 시작됨
            // startPosition 옵션만 믿으면, hls.js가 내부적으로 seek를 적용하기 전에
            // play()가 먼저 실행되어 브라우저가 기본 위치(0초)의 프래그먼트도 함께
            // 요청하는 경우가 있었음 (예: 9초 지점에서 화질 변경 시 seq=3과 seq=0이
            // 거의 동시에 요청되어 서버가 "탐색 감지"로 오인, 불필요한 재시작 발생).
            // Direct Play/Safari 네이티브 분기와 동일하게 currentTime을 명시적으로
            // 지정해 정상적인 seek 경로를 강제한다.
            if (savedTime > 0) {
                videoPlayer.currentTime = savedTime;
            }
            if (!wasPaused || savedTime === 0) {
                videoPlayer.play().catch(() => { });
            }
        });

        const onCanPlay = () => {
            videoPlayer.removeEventListener('canplay', onCanPlay);
            if (myLoadToken !== qualityLoadToken) return;
            hideLoading();
        };
        videoPlayer.addEventListener('canplay', onCanPlay);

        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.warn('HLS 네트워크 오류, 자동 복구 시도...');
                        hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.warn('HLS 미디어 오류, 자동 복구 시도...');
                        hls.recoverMediaError();
                        break;
                    default:
                        console.error('HLS 치명적 오류:', data);
                        hideLoading();
                        break;
                }
            }
        });
    }
}

// ─── 버퍼링 상태 감지 (로딩 인디케이터 자동 표시) ───
// waiting/stalled는 실제로는 재생이 끊기지 않았는데도 아주 짧게(오탐지) 발동하는
// 경우가 흔함(특히 MSE/hls.js 재생). 발동 즉시 오버레이를 띄우면 정상 재생 중에도
// 화면이 번쩍이므로, 살짝(200ms) 지연시켜 그 사이 playing/timeupdate로 정상 재생이
// 확인되면 아예 표시하지 않고, 진짜로 버퍼링이 지속될 때만 오버레이를 띄운다.
let loadingShowTimer = null;
function scheduleShowLoading(text) {
    if (loadingShowTimer) return;
    loadingShowTimer = setTimeout(() => {
        loadingShowTimer = null;
        showLoading(text);
    }, 200);
}
function cancelScheduledLoading() {
    if (loadingShowTimer) {
        clearTimeout(loadingShowTimer);
        loadingShowTimer = null;
    }
}

videoPlayer.addEventListener('waiting', () => {
    // 일시정지 상태에서는 waiting이 반복적으로 발동할 수 있는데, 그때마다 예약을 걸면
    // pause 핸들러가 한 번 해제해도 다시 떠버려 고착된 것처럼 보임. 일시정지는 사용자가
    // 의도한 상태이므로 애초에 예약 자체를 하지 않는다.
    if (isPlayerMode && currentVideoId && !videoPlayer.paused) {
        scheduleShowLoading('버퍼링 중...');
    }
});
videoPlayer.addEventListener('playing', () => {
    cancelScheduledLoading();
    hideLoading();
});
videoPlayer.addEventListener('stalled', () => {
    if (isPlayerMode && currentVideoId && !videoPlayer.paused) {
        scheduleShowLoading('데이터 대기 중...');
    }
});
// timeupdate가 발생한다는 건 재생 시간이 실제로 흐르고 있다는 확실한 증거이므로,
// 예약된 표시를 취소하고(아직 안 떴다면 번쩍임 자체를 방지) 이미 떠 있다면 해제한다.
videoPlayer.addEventListener('timeupdate', () => {
    if (!videoPlayer.paused && !videoPlayer.seeking) {
        cancelScheduledLoading();
        hideLoading();
    }
});
// 일시정지 상태에서는 playing/timeupdate가 발생하지 않으므로, 일시정지 직전/중에
// waiting이나 stalled가 한 번이라도 발동했다면 오버레이가 해제될 방법이 없어 계속
// 떠 있는 상태로 고착되는 문제가 있었음. 일시정지는 사용자의 의도된 상태이므로
// 버퍼링 표시가 필요 없다 — pause 시 예약된 표시를 취소하고 즉시 해제한다.
videoPlayer.addEventListener('pause', () => {
    cancelScheduledLoading();
    hideLoading();
});

// ─── 화질 메뉴 ───
function updateQualityMenu() {
    qualityMenu.querySelectorAll('.quality-option').forEach(el => el.remove());

    qualities.forEach(q => {
        const option = document.createElement('div');
        option.className = `quality-option${q.name === currentQuality ? ' active' : ''}`;
        option.innerHTML = `<span class="check">${q.name === currentQuality ? '✓' : ''}</span><span>${q.label}</span>`;
        option.onclick = (e) => {
            e.stopPropagation();
            if (q.name !== currentQuality) {
                loadQuality(q.name);
            }
            qualityMenu.classList.remove('visible');
        };
        qualityMenu.appendChild(option);
    });
}

btnQuality.onclick = (e) => {
    e.stopPropagation();
    qualityMenu.classList.toggle('visible');
};

document.addEventListener('click', () => {
    qualityMenu.classList.remove('visible');
});

// ─── 재생/정지 ───
function togglePlay() {
    if (!currentVideoId || !isPlayerMode) return;
    if (videoPlayer.paused) {
        videoPlayer.play().catch(() => { });
    } else {
        videoPlayer.pause();
    }
}

btnPlay.onclick = togglePlay;
centerPlay.onclick = togglePlay;
videoPlayer.addEventListener('click', togglePlay);

videoPlayer.addEventListener('play', () => {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    centerPlay.classList.remove('visible');
});

videoPlayer.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    centerPlay.classList.add('visible');
});

btnRepeat.onclick = () => {
    isRepeat = !isRepeat;
    if (isRepeat) {
        btnRepeat.classList.add('active');
    } else {
        btnRepeat.classList.remove('active');
    }
};

videoPlayer.addEventListener('ended', () => {
    if (isRepeat) {
        videoPlayer.currentTime = 0;
        videoPlayer.play();
    } else {
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        centerPlay.classList.add('visible');
    }
});

// ─── 볼륨 ───
btnMute.onclick = () => {
    videoPlayer.muted = !videoPlayer.muted;
    updateVolumeUI();
};

volumeSlider.oninput = () => {
    videoPlayer.volume = parseFloat(volumeSlider.value);
    videoPlayer.muted = videoPlayer.volume === 0;
    updateVolumeUI();
};

function updateVolumeUI() {
    const muted = videoPlayer.muted || videoPlayer.volume === 0;
    iconVol.style.display = muted ? 'none' : 'block';
    iconMuted.style.display = muted ? 'block' : 'none';
    if (!videoPlayer.muted) {
        volumeSlider.value = videoPlayer.volume;
    }
}

// ─── 프로그레스 바 ───
videoPlayer.addEventListener('timeupdate', () => {
    if (isSeeking || !isPlayerMode) return;
    updateProgress();
});

function updateProgress() {
    const duration = videoPlayer.duration || 0;
    const current = videoPlayer.currentTime || 0;
    if (duration > 0) {
        const pct = (current / duration) * 100;
        progressPlayed.style.width = pct + '%';
        progressThumb.style.left = pct + '%';
        timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }

    if (videoPlayer.buffered.length > 0) {
        const buffEnd = videoPlayer.buffered.end(videoPlayer.buffered.length - 1);
        progressBuffered.style.width = (buffEnd / duration) * 100 + '%';
    }
}

progressContainer.addEventListener('mousedown', (e) => {
    isSeeking = true;
    seek(e);
    const onMove = (e) => seek(e);
    const onUp = () => {
        isSeeking = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
});

function seek(e) {
    const rect = progressContainer.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const duration = videoPlayer.duration || 0;
    videoPlayer.currentTime = pct * duration;
    progressPlayed.style.width = (pct * 100) + '%';
    progressThumb.style.left = (pct * 100) + '%';
    timeDisplay.textContent = `${formatTime(pct * duration)} / ${formatTime(duration)}`;
}

// ─── 전체화면 ───
btnFullscreen.onclick = toggleFullscreen;

if (btnPip) {
    btnPip.onclick = async () => {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && videoPlayer.requestPictureInPicture) {
                await videoPlayer.requestPictureInPicture();
            } else if (videoPlayer.webkitSupportsPresentationMode && videoPlayer.webkitSupportsPresentationMode('picture-in-picture')) {
                videoPlayer.webkitSetPresentationMode(
                    videoPlayer.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'
                );
            } else {
                showToast('이 브라우저 또는 현재 비디오 상태에서는 PIP 기능을 지원하지 않습니다.', 'error');
            }
        } catch (err) {
            console.error('PIP 오류:', err);
            showToast('PIP 모드 전환 중 오류가 발생했습니다.', 'error');
        }
    };
}

function toggleFullscreen() {
    const isIPhone = /iPhone|iPod/i.test(navigator.userAgent);

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (isIPhone && videoPlayer.webkitEnterFullscreen) {
            // 아이폰은 비디오 태그 자체만 전체화면 가능
            videoPlayer.webkitEnterFullscreen();
        } else if (playerWrapper.requestFullscreen) {
            playerWrapper.requestFullscreen().catch(() => { });
        } else if (playerWrapper.webkitRequestFullscreen) {
            playerWrapper.webkitRequestFullscreen(); // 아이패드 및 Mac Safari
        } else if (videoPlayer.webkitEnterFullscreen) {
            videoPlayer.webkitEnterFullscreen(); // 예비용
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => { });
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen(); // Mac Safari
        }
    }
}

const handleFsChange = () => {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    iconFsEnter.style.display = isFs ? 'none' : 'block';
    iconFsExit.style.display = isFs ? 'block' : 'none';
};

document.addEventListener('fullscreenchange', handleFsChange);
document.addEventListener('webkitfullscreenchange', handleFsChange);

// ─── 컨트롤 자동 숨김 ───
playerWrapper.addEventListener('mousemove', () => {
    if (!isPlayerMode) return;
    playerWrapper.classList.add('controls-visible');
    clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
        if (!videoPlayer.paused && !qualityMenu.classList.contains('visible')) {
            playerWrapper.classList.remove('controls-visible');
        }
    }, 3000);
});

playerWrapper.addEventListener('mouseleave', () => {
    if (!videoPlayer.paused && isPlayerMode) {
        playerWrapper.classList.remove('controls-visible');
    }
});

// ─── 키보드 단축키 ───
document.addEventListener('keydown', (e) => {
    if (isImageViewerMode) {
        if (e.key === 'Escape') {
            showLibrary();
            return;
        }
        if (e.key === 'ArrowLeft' && currentImageIndex > 0) {
            currentImageIndex--;
            loadImage(currentImageIndex);
        }
        if (e.key === 'ArrowRight' && currentImageIndex < currentImages.length - 1) {
            currentImageIndex++;
            loadImage(currentImageIndex);
        }
        return;
    }

    if (!isPlayerMode) return;

    // 플레이어 모드에서 ESC 누르면 라이브러리로 복귀 (전체화면 아닐 때만)
    if (e.key === 'Escape' && !document.fullscreenElement && !document.webkitFullscreenElement) {
        showLibrary();
        return;
    }

    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 5);
            break;
        case 'ArrowRight':
            e.preventDefault();
            videoPlayer.currentTime = Math.min(videoPlayer.duration, videoPlayer.currentTime + 5);
            break;
        case 'ArrowUp':
            e.preventDefault();
            videoPlayer.volume = Math.min(1, videoPlayer.volume + 0.1);
            volumeSlider.value = videoPlayer.volume;
            updateVolumeUI();
            break;
        case 'ArrowDown':
            e.preventDefault();
            videoPlayer.volume = Math.max(0, videoPlayer.volume - 0.1);
            volumeSlider.value = videoPlayer.volume;
            updateVolumeUI();
            break;
        case 'f':
        case 'F':
            toggleFullscreen();
            break;
        case 'm':
        case 'M':
            videoPlayer.muted = !videoPlayer.muted;
            updateVolumeUI();
            break;
        case 'p':
        case 'P':
            if (btnPip) btnPip.click();
            break;
    }
});

const btnResetAccount = document.getElementById('btn-reset-account');
if (btnResetAccount) {
    btnResetAccount.onclick = async () => {
        const confirmText = '계정 삭제 및 초기화';
        const result = await showCustomDialog({
            type: 'prompt',
            title: '위험: 계정 삭제 및 초기화',
            message: `이 작업은 되돌릴 수 없으며, 모든 관리자 정보 및 패스키가 삭제됩니다.\n계속하려면 아래 입력창에 "${confirmText}" 를 정확히 입력하세요.`,
            requireMatch: confirmText
        });

        if (result === confirmText) {
            try {
                const res = await fetch('/api/auth/reset', { method: 'POST' });
                if (res.ok) {
                    showToast('초기화가 완료되었습니다. 설정 화면으로 이동합니다.', 'success');
                    setTimeout(() => location.reload(), 1500);
                } else {
                    const err = await res.json();
                    showToast(err.error || '초기화 실패', 'error');
                }
            } catch (err) {
                console.error(err);
                showToast('초기화 중 오류가 발생했습니다.', 'error');
            }
        }
    };
}

// ─── 렌더링 유틸리티 ───
function formatTime(sec) {
    if (isNaN(sec) || sec < 0) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function showLoading(text) {
    loadingText.textContent = text || '로딩 중...';
    loadingOverlay.classList.add('visible');
}

function hideLoading() {
    loadingOverlay.classList.remove('visible');
}

// ─── 설정 로직 ───
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const btnSettingsClose = document.getElementById('btn-settings-close');
const btnSettingsSaves = document.querySelectorAll('.btn-settings-save');
const inputMediaDir = document.getElementById('input-media-dir');

// 탭 전환 로직
const settingsTabs = document.querySelectorAll('.settings-tab');
const settingsPanes = document.querySelectorAll('.settings-pane');

settingsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        settingsTabs.forEach(t => t.classList.remove('active'));
        settingsPanes.forEach(p => p.classList.remove('active'));

        tab.classList.add('active');
        document.getElementById(tab.dataset.target).classList.add('active');

        if (tab.dataset.target === 'settings-ffmpeg') {
            loadFfmpegSettings();
        }
    });
});

// 패스키 포맷 헬퍼
function formatDate(dateStr) {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function loadAccountInfo() {
    const displayUsername = document.getElementById('display-username');
    const passkeysContainer = document.getElementById('passkeys-list-container');

    try {
        passkeysContainer.innerHTML = '<div style="color: #a1a1aa; font-size: 13px;">불러오는 중...</div>';
        const res = await fetch('/api/auth/account-info');
        if (!res.ok) throw new Error('계정 정보를 불러올 수 없습니다.');
        const data = await res.json();

        displayUsername.value = data.username;
        const changePwdUsername = document.getElementById('change-pwd-username');
        if (changePwdUsername) changePwdUsername.value = data.username;

        if (data.passkeys && data.passkeys.length > 0) {
            let html = '<ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;">';
            const isOnlyOne = data.passkeys.length === 1;

            function getIcon(deviceName) {
                const d = deviceName.toLowerCase();
                if (d.includes('iphone') || d.includes('ipad') || d.includes('android')) {
                    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="color: #a78bfa; margin-right: 8px; flex-shrink: 0;"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>`;
                } else if (d.includes('mac') || d.includes('windows') || d.includes('linux')) {
                    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="color: #a78bfa; margin-right: 8px; flex-shrink: 0;"><path d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z"/></svg>`;
                } else {
                    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="color: #a78bfa; margin-right: 8px; flex-shrink: 0;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
                }
            }

            data.passkeys.forEach((pk, index) => {
                const disabledAttr = isOnlyOne ? 'disabled' : '';
                const disabledStyle = isOnlyOne ? 'opacity: 0.3; cursor: not-allowed; border-color: transparent;' : 'color: #ef4444; border-color: rgba(239, 68, 68, 0.3);';

                html += `
                            <li style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 6px;">
                                <div style="display: flex; align-items: center;">
                                    ${getIcon(pk.name)}
                                    <div>
                                        <div style="font-size: 14px; color: #fff; font-weight: 500;">${pk.name}</div>
                                        <div style="font-size: 12px; color: #a1a1aa;">등록일: ${formatDate(pk.created_at)}</div>
                                    </div>
                                </div>
                                <div style="display: flex; gap: 6px;">
                                    <button class="btn-rename-passkey btn-secondary" data-id="${pk.id}" data-name="${pk.name}" style="padding: 4px 8px; font-size: 12px;">이름 변경</button>
                                    <button class="btn-delete-passkey btn-secondary" data-id="${pk.id}" ${disabledAttr} style="padding: 4px 8px; font-size: 12px; ${disabledStyle}">삭제</button>
                                </div>
                            </li>
                        `;
            });
            html += '</ul>';
            passkeysContainer.innerHTML = html;

            // 삭제 이벤트 바인딩
            document.querySelectorAll('.btn-delete-passkey').forEach(btn => {
                btn.onclick = async () => {
                    if (!(await showConfirm('패스키 삭제', '정말 이 패스키를 삭제하시겠습니까?'))) return;
                    try {
                        const delRes = await fetch(`/api/auth/passkeys/${btn.dataset.id}`, { method: 'DELETE' });
                        const delData = await delRes.json();
                        if (delData.success) {
                            loadAccountInfo(); // 재렌더링
                        } else {
                            showToast(delData.error || '삭제 실패', 'error');
                        }
                    } catch (err) {
                        showToast('패스키 삭제 중 오류가 발생했습니다.', 'error');
                    }
                };
            });

            // 이름 변경 이벤트 바인딩
            document.querySelectorAll('.btn-rename-passkey').forEach(btn => {
                btn.onclick = async () => {
                    const currentName = btn.dataset.name;
                    const newName = await showPrompt('이름 변경', '새로운 패스키 이름을 입력하세요:', currentName);
                    if (newName === null || newName.trim() === '') return;
                    if (newName.trim() === currentName) return;

                    try {
                        const res = await fetch(`/api/auth/passkeys/${btn.dataset.id}/name`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: newName })
                        });
                        const data = await res.json();
                        if (data.success) {
                            loadAccountInfo();
                        } else {
                            showToast(data.error || '이름 변경 실패', 'error');
                        }
                    } catch (err) {
                        showToast('이름 변경 중 오류가 발생했습니다.', 'error');
                    }
                };
            });
        } else {
            passkeysContainer.innerHTML = '<div style="color: #a1a1aa; font-size: 13px;">등록된 패스키가 없습니다.</div>';
        }
    } catch (err) {
        console.error(err);
        passkeysContainer.innerHTML = '<div style="color: #ef4444; font-size: 13px;">오류가 발생했습니다.</div>';
    }
}

const btnAddPasskey = document.getElementById('btn-add-passkey');
if (btnAddPasskey) {
    btnAddPasskey.onclick = async () => {
        try {
            const optRes = await fetch('/api/auth/passkey/add-options');
            const optData = await optRes.json();

            if (optData.error) return showToast(optData.error, 'error');

            let attResp;
            try {
                attResp = await SimpleWebAuthnBrowser.startRegistration(optData);
            } catch (error) {
                if (error.name === 'NotAllowedError') {
                    return showToast('패스키 생성이 취소되었습니다.', 'info');
                }
                throw error;
            }

            const verRes = await fetch('/api/auth/passkey/add-verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(attResp)
            });
            const verData = await verRes.json();
            if (verData.verified) {
                showToast('새 패스키가 추가되었습니다!', 'success');
                loadAccountInfo();
            } else {
                showToast('패스키 등록 실패: ' + (verData.error || '알 수 없는 오류'), 'error');
            }
        } catch (err) {
            console.error(err);
            showToast('패스키 생성 중 오류가 발생했습니다.', 'error');
        }
    };
}

const formChangePassword = document.getElementById('form-change-password');
if (formChangePassword) {
    formChangePassword.onsubmit = async (e) => {
        e.preventDefault();
        document.activeElement?.blur();

        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;

        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await res.json();

            if (data.success) {
                formChangePassword.submit(); // 비밀번호 변경 성공 시에만 브라우저 암호 업데이트 유도
                showToast('비밀번호가 성공적으로 변경되었습니다.', 'success');
                document.getElementById('current-password').value = '';
                document.getElementById('new-password').value = '';
            } else {
                showToast('비밀번호 변경 실패: ' + (data.error || '알 수 없는 오류'), 'error');
            }
        } catch (err) {
            console.error(err);
            showToast('비밀번호 변경 중 오류가 발생했습니다.', 'error');
        }
    };
}

async function loadTranscoderSettings() {
    try {
        const gpuInfo = document.getElementById('settings-gpu-info');
        if (gpuInfo) {
            if (gpuInfo.tagName === 'INPUT') gpuInfo.value = '조회 중...';
            else gpuInfo.innerText = '조회 중...';
        }
        const res = await fetch('/api/settings/transcoder');
        const data = await res.json();
        
        if (gpuInfo) {
            if (gpuInfo.tagName === 'INPUT') gpuInfo.value = data.gpu || '알 수 없는 하드웨어';
            else gpuInfo.innerText = data.gpu || '알 수 없는 하드웨어';
        }
        
        const radios = document.getElementsByName('transcoder_codec');
        for (let r of radios) {
            if (r.value === data.codec) {
                r.checked = true;
                break;
            }
        }
    } catch (err) {
        console.error('트랜스코더 설정 로드 오류:', err);
        const gpuInfo = document.getElementById('settings-gpu-info');
        if (gpuInfo) {
            if (gpuInfo.tagName === 'INPUT') gpuInfo.value = '불러오기 실패';
            else gpuInfo.innerText = '불러오기 실패';
        }
    }
}

// ─── FFmpeg 관리 로직 ───
let ffmpegUpdatePollingTimer = null;

async function loadFfmpegSettings(forceCheck = false) {
    const currentVersionEl = document.getElementById('ffmpeg-current-version');
    const latestVersionEl = document.getElementById('ffmpeg-latest-version');
    const pathInput = document.getElementById('ffmpeg-current-path');
    const statusBadge = document.getElementById('ffmpeg-status-badge');
    const btnCheck = document.getElementById('btn-ffmpeg-check');
    const btnUpdate = document.getElementById('btn-ffmpeg-update');
    const btnUpdateText = document.getElementById('btn-ffmpeg-update-text');

    if (!currentVersionEl) return;

    try {
        if (forceCheck) {
            statusBadge.className = 'ffmpeg-badge badge-checking';
            statusBadge.innerText = '확인 중...';
            if (btnCheck) btnCheck.disabled = true;
        }

        const endpoint = forceCheck ? '/api/settings/ffmpeg/check' : '/api/settings/ffmpeg';
        const res = await fetch(endpoint, {
            method: forceCheck ? 'POST' : 'GET'
        });
        const data = await res.json();

        const current = data.current || {};
        const latest = data.latest || {};
        const updateState = data.updateState || {};

        currentVersionEl.innerText = current.installed ? (current.tag || `v${current.version}`) : '미설치';
        latestVersionEl.innerText = latest.releaseTag || (latest.latestVersion ? `v${latest.latestVersion}` : '-');
        if (pathInput) pathInput.value = current.path || '';

        const sourceBadge = document.getElementById('ffmpeg-source-badge');
        if (sourceBadge) {
            if (current.sourceType === 'system') {
                sourceBadge.className = 'ffmpeg-source-tag source-system';
                sourceBadge.innerHTML = '📦 리눅스 시스템 패키지 매니저 (APT 등)';
            } else if (current.sourceType === 'local') {
                sourceBadge.className = 'ffmpeg-source-tag source-local';
                sourceBadge.innerHTML = '⚡ LightMediaBox 직접 다운로드 (포터블)';
            } else {
                sourceBadge.className = 'ffmpeg-source-tag';
                sourceBadge.innerText = current.sourceLabel || '미설치';
            }
        }

        // 상태 뱃지 및 업데이트 버튼 활성화 처리
        if (updateState.isUpdating) {
            statusBadge.className = 'ffmpeg-badge badge-checking';
            statusBadge.innerText = '업데이트 진행 중';
            if (btnUpdate) btnUpdate.disabled = true;
            if (btnUpdateText) btnUpdateText.innerText = '업데이트 중...';
            showFfmpegProgress(updateState);
            startFfmpegPolling();
        } else if (latest.hasUpdate) {
            statusBadge.className = 'ffmpeg-badge badge-update-available';
            statusBadge.innerText = `업데이트 가능 (${latest.releaseTag || latest.latestVersion})`;
            if (btnUpdate) btnUpdate.disabled = false;
            if (btnUpdateText) btnUpdateText.innerText = `v${latest.latestVersion}로 업데이트`;
        } else if (current.installed) {
            statusBadge.className = 'ffmpeg-badge badge-up-to-date';
            statusBadge.innerText = '최신 버전 사용 중';
            if (btnUpdate) btnUpdate.disabled = false;
            if (btnUpdateText) btnUpdateText.innerText = '최신 버전 재설치';
        } else {
            statusBadge.className = 'ffmpeg-badge badge-error';
            statusBadge.innerText = '미설치';
            if (btnUpdate) btnUpdate.disabled = false;
            if (btnUpdateText) btnUpdateText.innerText = 'FFmpeg 설치하기';
        }

        if (forceCheck) {
            showToast('최신 버전 정보를 확인했습니다.', 'success');
        }
    } catch (err) {
        console.error('FFmpeg 정보 로드 오류:', err);
        if (statusBadge) {
            statusBadge.className = 'ffmpeg-badge badge-error';
            statusBadge.innerText = '조회 실패';
        }
        if (forceCheck) {
            showToast('최신 버전 확인에 실패했습니다.', 'error');
        }
    } finally {
        if (btnCheck) btnCheck.disabled = false;
    }
}

function showFfmpegProgress(state) {
    const container = document.getElementById('ffmpeg-progress-container');
    const statusEl = document.getElementById('ffmpeg-progress-status');
    const percentEl = document.getElementById('ffmpeg-progress-percent');
    const barEl = document.getElementById('ffmpeg-progress-bar');

    if (!container) return;
    container.style.display = 'block';
    if (statusEl) statusEl.innerText = state.message || '진행 중...';
    if (percentEl) percentEl.innerText = `${state.percent || 0}%`;
    if (barEl) barEl.style.width = `${state.percent || 0}%`;
}

function hideFfmpegProgress() {
    const container = document.getElementById('ffmpeg-progress-container');
    if (container) {
        container.style.display = 'none';
    }
}

function startFfmpegPolling() {
    if (ffmpegUpdatePollingTimer) return;

    ffmpegUpdatePollingTimer = setInterval(async () => {
        try {
            const res = await fetch('/api/settings/ffmpeg/progress');
            const state = await res.json();

            showFfmpegProgress(state);

            if (!state.isUpdating) {
                clearInterval(ffmpegUpdatePollingTimer);
                ffmpegUpdatePollingTimer = null;

                if (state.step === 'completed') {
                    showToast(state.message || 'FFmpeg 업데이트가 완료되었습니다!', 'success');
                    setTimeout(() => {
                        hideFfmpegProgress();
                    }, 3000);
                } else if (state.step === 'error') {
                    showToast(state.error || 'FFmpeg 업데이트 중 오류가 발생했습니다.', 'error');
                }
                loadFfmpegSettings();
            }
        } catch (err) {
            console.error('진행 상태 폴링 오류:', err);
        }
    }, 600);
}

// FFmpeg 관련 이벤트 바인딩
const btnFfmpegCheck = document.getElementById('btn-ffmpeg-check');
const btnFfmpegUpdate = document.getElementById('btn-ffmpeg-update');

if (btnFfmpegCheck) {
    btnFfmpegCheck.onclick = () => {
        loadFfmpegSettings(true);
    };
}

if (btnFfmpegUpdate) {
    btnFfmpegUpdate.onclick = async () => {
        const btnUpdateText = document.getElementById('btn-ffmpeg-update-text');
        try {
            btnFfmpegUpdate.disabled = true;
            if (btnFfmpegCheck) btnFfmpegCheck.disabled = true;
            if (btnUpdateText) btnUpdateText.innerText = '업데이트 시작 중...';

            showFfmpegProgress({
                percent: 0,
                message: '업데이트 요청 중...'
            });

            const res = await fetch('/api/settings/ffmpeg/update', { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || '업데이트 요청에 실패했습니다.');
            }

            startFfmpegPolling();
        } catch (err) {
            console.error('업데이트 시작 실패:', err);
            showToast(err.message || '업데이트를 시작할 수 없습니다.', 'error');
            hideFfmpegProgress();
            btnFfmpegUpdate.disabled = false;
            if (btnFfmpegCheck) btnFfmpegCheck.disabled = false;
            loadFfmpegSettings();
        }
    };
}

btnSettings.onclick = async () => {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        inputMediaDir.value = config.mediaDir || '';

        // 설정 창 열릴 때 계정 정보, 트랜스코딩 정보, FFmpeg 정보 로드
        loadAccountInfo();
        loadTranscoderSettings();
        loadFfmpegSettings();

        settingsModal.classList.add('visible');
    } catch (err) {
        console.error('설정 로드 실패', err);
    }
};

btnSettingsClose.onclick = () => {
    settingsModal.classList.remove('visible');
};

btnSettingsSaves.forEach(btn => {
    btn.onclick = async () => {
        const newDir = inputMediaDir.value.trim();
        if (!newDir) return showToast('경로를 입력해주세요.', 'error');

        let selectedCodec = 'libx264';
        const radios = document.getElementsByName('transcoder_codec');
        for (let r of radios) {
            if (r.checked) {
                selectedCodec = r.value;
                break;
            }
        }

        try {
            showLoading('설정을 적용하고 있습니다...');
            settingsModal.classList.remove('visible');

            const resConfig = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mediaDir: newDir })
            });
            
            await fetch('/api/settings/transcoder', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codec: selectedCodec })
            });

            const data = await resConfig.json();
            if (data.success) {
                // 성공 시 뷰 전환(폴더뷰로) 및 초기 경로 재로드
                currentViewMode = 'folder';
                updateTabsUI();
                browsePath('');
                showToast('설정이 성공적으로 저장되었습니다.', 'success');
            } else {
                showToast('경로 변경 실패: ' + (data.error || '알 수 없는 오류'), 'error');
            }
        } catch (err) {
            console.error(err);
            showToast('설정 중 오류가 발생했습니다: ' + err.message, 'error');
        } finally {
            hideLoading();
        }
    };
});

// ─── 시스템 폴더 브라우저 ───
const btnBrowsePath = document.getElementById('btn-browse-path');
const systemBrowser = document.getElementById('system-browser');

btnBrowsePath.onclick = (e) => {
    e.preventDefault();
    if (systemBrowser.style.display === 'flex') {
        systemBrowser.style.display = 'none';
    } else {
        systemBrowser.style.display = 'flex';
        loadSystemBrowse(inputMediaDir.value);
    }
};

async function loadSystemBrowse(targetPath) {
    systemBrowser.innerHTML = '<div style="color:#a1a1aa; font-size:13px; text-align:center; padding:16px;">로딩 중...</div>';
    try {
        const res = await fetch(`/api/system-browse?path=${encodeURIComponent(targetPath || '')}`);
        if (!res.ok) throw new Error('경로를 불러올 수 없습니다.');
        const data = await res.json();

        // 폴더 이동 시 실시간으로 경로 입력창 업데이트
        if (data.currentPath) {
            inputMediaDir.value = data.currentPath;
        }

        systemBrowser.innerHTML = '';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
        header.style.paddingBottom = '8px';
        header.style.marginBottom = '8px';
        header.style.gap = '8px';

        const currentPathSpan = document.createElement('span');
        currentPathSpan.style.fontSize = '12px';
        currentPathSpan.style.color = '#a78bfa';
        currentPathSpan.style.wordBreak = 'break-all';
        currentPathSpan.style.fontWeight = '600';
        currentPathSpan.textContent = data.currentPath || '내 PC (드라이브 목록)';

        header.appendChild(currentPathSpan);
        systemBrowser.appendChild(header);

        if (data.parentPath !== null) {
            const upBtn = document.createElement('div');
            upBtn.className = 'browser-item';
            upBtn.innerHTML = '<span>📁</span> <span>.. (상위 폴더)</span>';
            upBtn.onclick = () => loadSystemBrowse(data.parentPath);
            systemBrowser.appendChild(upBtn);
        }

        data.folders.forEach(f => {
            const fBtn = document.createElement('div');
            fBtn.className = 'browser-item';
            fBtn.innerHTML = `<span>📁</span> <span>${f.name}</span>`;
            fBtn.onclick = () => loadSystemBrowse(f.path);
            systemBrowser.appendChild(fBtn);
        });

        if (data.folders.length === 0 && data.parentPath === null && data.currentPath) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.color = '#71717a';
            emptyMsg.style.fontSize = '12px';
            emptyMsg.style.padding = '8px';
            emptyMsg.style.textAlign = 'center';
            emptyMsg.textContent = '폴더가 없습니다.';
            systemBrowser.appendChild(emptyMsg);
        }

    } catch (err) {
        systemBrowser.innerHTML = '<div style="color:#ef4444; font-size:13px; text-align:center; padding:16px;">경로를 불러올 수 없거나 권한이 없습니다.</div>';
    }
}

// ─── 인증 및 온보딩 로직 ───
const authView = document.getElementById('auth-view');
const authSetupForm = document.getElementById('auth-setup-form');
const authLoginForm = document.getElementById('auth-login-form');

const formRegister = document.getElementById('form-register');
const formLogin = document.getElementById('form-login');

async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth/session');
        const data = await res.json();

        if (data.loggedIn) {
            authView.classList.add('hidden');
            libraryView.classList.remove('hidden');

            try {
                const tokenRes = await fetch('/api/auth/stream-token');
                const tokenData = await tokenRes.json();
                window.streamToken = tokenData.token;
            } catch (e) {
                console.error('스트리밍 토큰 발급 실패', e);
            }

            // 모바일 사파리 등에서 로그인 시 OS 키보드/줌 때문에 내려간 스크롤을 최상단으로 복구
            // WebAuthn UI 종료 및 화면 렌더링 후 적용되도록 충분한 지연 시간 확보 (300ms)
            setTimeout(() => window.scrollTo(0, 0), 300);

            if (currentViewMode === 'folder') {
                browsePath('');
            } else {
                loadLibrary();
            }
        } else {
            // Not logged in. Check setup status.
            authView.classList.remove('hidden');
            libraryView.classList.add('hidden');

            const setupRes = await fetch('/api/auth/setup-status');
            const setupData = await setupRes.json();

            if (setupData.isSetup) {
                authSetupForm.style.display = 'none';
                authLoginForm.style.display = 'block';
            } else {
                authSetupForm.style.display = 'block';
                authLoginForm.style.display = 'none';
            }
        }
    } catch (err) {
        console.error('인증 상태 확인 실패', err);
    }
}

formRegister.onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const password = document.getElementById('reg-password').value;

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            showToast('관리자 계정이 생성되었습니다. 이제 로그인 후 패스키를 등록해주세요.', 'info');
            checkAuthStatus();
        } else {
            showToast(data.error || '회원가입 실패', 'error');
        }
    } catch (err) {
        showToast('회원가입 요청 중 오류가 발생했습니다.', 'error');
    }
};

formLogin.onsubmit = async (e) => {
    e.preventDefault();
    document.activeElement?.blur();

    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.success && data.require2FA) {
            formLogin.submit(); // 로그인 성공 시에만 브라우저 암호 저장 유도

            const { SimpleWebAuthnBrowser } = window;
            if (!data.hasPasskey) {
                // 최초 로그인: 패스키 등록
                showToast('최초 1회 2단계 인증용 패스키를 등록해야 합니다.', 'info');
                const optRes = await fetch('/api/auth/passkey/register-options');
                const optData = await optRes.json();

                let attResp;
                try {
                    attResp = await SimpleWebAuthnBrowser.startRegistration(optData);
                } catch (error) {
                    if (error.name === 'NotAllowedError') {
                        return showToast('패스키 등록이 취소되었습니다.', 'info');
                    }
                    throw error;
                }

                const verRes = await fetch('/api/auth/passkey/register-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(attResp)
                });
                const verData = await verRes.json();
                if (verData.verified) {
                    showToast('패스키 등록 및 로그인이 완료되었습니다!', 'success');
                    checkAuthStatus();
                } else {
                    showToast('패스키 등록 실패: ' + (verData.error || '알 수 없는 오류'), 'error');
                }
            } else {
                // 패스키 인증
                const optRes = await fetch('/api/auth/passkey/auth-options');
                const optData = await optRes.json();

                let asseResp;
                try {
                    asseResp = await SimpleWebAuthnBrowser.startAuthentication(optData);
                } catch (error) {
                    if (error.name === 'NotAllowedError') {
                        return showToast('패스키 인증이 취소되었습니다.', 'info');
                    }
                    throw error;
                }

                const verRes = await fetch('/api/auth/passkey/auth-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(asseResp)
                });
                const verData = await verRes.json();
                if (verData.verified) {
                    checkAuthStatus();
                } else {
                    showToast('패스키 인증 실패: ' + (verData.error || '알 수 없는 오류'), 'error');
                }
            }
        } else {
            showToast(data.error || '로그인 실패', 'error');
        }
    } catch (err) {
        showToast('로그인 요청 중 오류가 발생했습니다.', 'error');
        console.error(err);
    }
};

btnLogout.onclick = async () => {
    if (await showConfirm('로그아웃', '로그아웃하시겠습니까?')) {
        await fetch('/api/auth/logout', { method: 'POST' });
        checkAuthStatus();
    }
};

// 앱 초기화 시작
checkAuthStatus();

// ─── AirPlay & Chromecast 지원 ───

const btnAirplay = document.getElementById('btn-airplay');
const btnCastWrapper = document.getElementById('btn-cast-wrapper');

// 1. AirPlay (Safari 전용)
if (window.WebKitPlaybackTargetAvailabilityEvent) {
    videoPlayer.addEventListener('webkitplaybacktargetavailabilitychanged', function (event) {
        if (event.availability === 'available') {
            btnAirplay.style.display = 'block';
        } else {
            btnAirplay.style.display = 'none';
        }
    });

    btnAirplay.addEventListener('click', function () {
        videoPlayer.webkitShowPlaybackTargetPicker();
    });
}

// 2. Google Cast (Chromecast)
let castSession = null;

if (window.isCastAvailable) {
    window.initializeCastApi();
}

window.initializeCastApi = function() {
    cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });

    btnCastWrapper.style.display = 'block';

    btnCastWrapper.onclick = () => {
        try {
            cast.framework.CastContext.getInstance().requestSession().catch((err) => {
                if (err !== 'cancel') console.error('Cast session request error:', err);
            });
        } catch (e) {
            console.error('Cast API not ready', e);
        }
    };

    const context = cast.framework.CastContext.getInstance();
    context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, function (event) {
        if (event.sessionState === cast.framework.SessionState.SESSION_STARTED || event.sessionState === cast.framework.SessionState.SESSION_RESUMED) {
            castSession = context.getCurrentSession();
            castCurrentVideo();
        } else if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
            castSession = null;
        }
    });
}

function castCurrentVideo() {
    if (!castSession || !currentVideoId) return;

    const origin = window.location.origin;
    let url = '';

    // HLS.js나 native 플레이어에 공급되는 url과 동일하게 전송
    if (currentQuality === 'original') {
        url = `${origin}/api/video/${currentVideoId}/direct?token=${window.streamToken || ''}`;
    } else {
        url = `${origin}/api/hls/${currentVideoId}/${currentQuality}/index.m3u8?token=${window.streamToken || ''}`;
    }

    const mediaInfo = new chrome.cast.media.MediaInfo(url, currentQuality === 'original' ? 'video/mp4' : 'application/x-mpegURL');

    const videoData = allVideos.find(v => String(v.id) === String(currentVideoId));
    if (videoData) {
        const metadata = new chrome.cast.media.GenericMediaMetadata();
        metadata.title = videoData.file_name;
        mediaInfo.metadata = metadata;
    }

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = videoPlayer.currentTime;

    castSession.loadMedia(request).then(
        function () {
            console.log('✅ 크롬캐스트로 전송 완료');
            videoPlayer.pause();
        },
        function (e) { console.error('❌ 크롬캐스트 전송 에러', e); }
    );
}

// 속도 측정 로직
const btnStartSpeedTest = document.getElementById('btn-start-speedtest');
const speedtestResultContainer = document.getElementById('speedtest-result-container');
const speedtestStatus = document.getElementById('speedtest-status');
const speedtestProgress = document.getElementById('speedtest-progress');
const speedtestMbps = document.getElementById('speedtest-mbps');

if (btnStartSpeedTest) {
    btnStartSpeedTest.addEventListener('click', () => {
        btnStartSpeedTest.disabled = true;
        btnStartSpeedTest.textContent = '측정 중...';
        speedtestResultContainer.style.display = 'block';
        speedtestStatus.textContent = '데이터 다운로드 중...';
        speedtestProgress.style.width = '0%';
        speedtestMbps.innerHTML = '0.0 <span style="font-size: 16px; color: rgba(255,255,255,0.5); font-weight: 400;">Mbps</span>';

        const startTime = performance.now();
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `/api/speedtest/download?t=${Date.now()}`, true);

        xhr.onprogress = (event) => {
            if (event.lengthComputable) {
                const percentComplete = (event.loaded / event.total) * 100;
                speedtestProgress.style.width = percentComplete + '%';

                const currentTime = performance.now();
                const durationSeconds = (currentTime - startTime) / 1000;
                if (durationSeconds > 0) {
                    const loadedBits = event.loaded * 8;
                    const mbps = (loadedBits / 1000000) / durationSeconds;
                    speedtestMbps.innerHTML = `${mbps.toFixed(1)} <span style="font-size: 16px; color: rgba(255,255,255,0.5); font-weight: 400;">Mbps</span>`;
                }
            }
        };

        xhr.onload = () => {
            btnStartSpeedTest.disabled = false;
            btnStartSpeedTest.textContent = '다시 측정';
            if (xhr.status === 200) {
                speedtestStatus.textContent = '측정 완료';
                speedtestProgress.style.width = '100%';
                
                const endTime = performance.now();
                const durationSeconds = (endTime - startTime) / 1000;
                const loadedBits = 50 * 1024 * 1024 * 8;
                const finalMbps = (loadedBits / 1000000) / durationSeconds;
                speedtestMbps.innerHTML = `${finalMbps.toFixed(1)} <span style="font-size: 16px; color: rgba(255,255,255,0.5); font-weight: 400;">Mbps</span>`;
            } else {
                speedtestStatus.textContent = '측정 실패 (서버 오류)';
            }
        };

        xhr.onerror = () => {
            btnStartSpeedTest.disabled = false;
            btnStartSpeedTest.textContent = '다시 측정';
            speedtestStatus.textContent = '네트워크 오류 발생';
        };

        xhr.send();
    });
}
