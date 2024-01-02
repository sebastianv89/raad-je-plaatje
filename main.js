const CLIENT_ID = 'e23eaf2e6b4f416b98d71c64d3bfa899'; 

const gotTokenEvent = new Event('gotToken');
const video = document.getElementById('playback');
const canvasElement = document.createElement('canvas');
const canvas = canvasElement.getContext('2d', {
    willReadFrequently: true,
});
const loginScreen = document.getElementById('loginScreen');
const startScreen = document.getElementById('startScreen');
const scanScreen = document.getElementById('scanScreen');
const playScreen = document.getElementById('playScreen');
const debugArea = document.getElementById('debugArea');
const deviceList = document.getElementById('device');
let animationRequest = null;

function showScreen(name) {
    loginScreen.style.display = 'none';
    startScreen.style.display = 'none';
    scanScreen.style.display = 'none';
    playScreen.style.display = 'none';
    if (name === 'start') {
        startScreen.style.display = 'flex';
    } else if (name === 'scan') {
        scanScreen.style.display = 'flex';
    } else if (name === 'play') {
        playScreen.style.display = 'flex';
    } else {
        loginScreen.style.display = 'flex';
    }
}

// Data structure for managing tokens
const currentToken = {
    get accessToken() { return localStorage.getItem('accessToken') || null; },
    get refreshToken() { return localStorage.getItem('refreshToken') || null; },
    get expires() {
        const timestamp = localStorage.getItem('expires');
        if (!timestamp) {
            return null;
        } else {
            return new Date(Number(timestamp));
        }
    },
    save: (response) => {
        const { access_token, refresh_token, expires_in } = response;
        const expires = new Date(Date.now() + 1000 * (expires_in - 10));
        localStorage.setItem('accessToken', access_token);
        localStorage.setItem('refreshToken', refresh_token);
        localStorage.setItem('expires', expires.valueOf());
        window.dispatchEvent(gotTokenEvent);
    }
};

async function newToken(code) {
    const codeVerifier = localStorage.getItem('codeVerifier');
    const url = new URL(window.location.href);
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: url.origin + url.pathname,
            code_verifier: codeVerifier,
        }),
    });
    if (response.status !== 200) {
        console.error(response, await response.text());
        throw Error('error fetching initial token');
    }
    currentToken.save(await response.json());
}

async function refreshToken() {
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: localStorage.getItem('refreshToken'),
        }),
    });
    if (response.status !== 200) {
        console.error(response, await response.text());
        throw Error('error refreshing token');
    }
    currentToken.save(await response.json());
}

function getCodeVerifier() {
    const allowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    const random = crypto.getRandomValues(new Uint8Array(43));
    return random.reduce((acc, x) => acc + allowed[x & 0x3f], '')
}

async function sha256(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

function base64url(bytes) {
    const binString = String.fromCharCode(...new Uint8Array(bytes));
    const urlCode = { '=': '', '+': '-', '/': '_' };
    return btoa(binString).replace(/[/+=]/g, x => urlCode[x]);
}

async function authorize() {
    const codeVerifier = getCodeVerifier();
    localStorage.setItem('codeVerifier', codeVerifier);
    const code_challenge = base64url(await sha256(codeVerifier));
    const url = new URL(window.location.href);
    // TODO: add state parameter to protect against CSRF
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.search = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: url.origin + url.pathname,
        scope: 'user-read-playback-state user-modify-playback-state',
        code_challenge_method: 'S256',
        code_challenge: code_challenge,
    }).toString();
    const shareData = { url: authUrl.toString() };
    if (navigator.canShare && navigator.canShare(shareData)) {
        console.log('Share');
        await navigator.share(shareData);
    } else {
        window.location.href = authUrl.toString();
    }
}

async function callApi(url, obj) {
    const response = await fetch(url, obj);
    if (response.status === 401) {
        await refreshToken();
        return await fetch(url, obj);
    }
    return response;
}

async function playTrack(trackId) {
    console.log('playTrack', trackId);
    const response = await callApi('https://api.spotify.com/v1/me/player/play', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken.accessToken}`,
        },
        body: JSON.stringify({
            uris: [`spotify:track:${trackId}`],
            position_ms: 0,
        }),
    });
    console.log('playTrack:', response);
    if (response.ok) {
        document.getElementById('playBtn').hidden = true;
        document.getElementById('pauseBtn').hidden = false;
        document.getElementById('scanBtn').classList.add('animatedPlay');
    }
    return response.ok;
}

async function scan() {
    console.log('scan');
    if (video.readyState >= 2) {
        // TODO: keep video aspect ratio
        canvas.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);
        const imgData = canvas.getImageData(0, 0, canvasElement.width, canvasElement.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height, {
            inversionAttempts: 'dontInvert'
        });
        if (code && code.data !== '') {
            const gotTrack = await playTrack(code.data);
            if (gotTrack) {
                console.log('got valid track, stopping scan');
                pauseScan();
                return;
            }
            console.log('continuing?');
        }
    }
    animationRequest = requestAnimationFrame(scan);
}

async function initScan() {
    console.log('initScan');
    showScreen('scan');
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('devices:', devices);
    // TODO: video is very(!) blocky, ugly, and hinders scanning accuracy
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then((stream) => {
            video.srcObject = stream;
            video.addEventListener('canplay', startScan);
        })
        .catch((err) => {
            console.error(err);
            cam.innerHTML = `Webcam not available: ${err}`;
        });
}

async function startScan() {
    console.log('startScan');
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;
    await video.play();
    requestAnimationFrame(scan);
    video.removeEventListener('canplay', startScan);
}

async function resumeScan() {
    console.log('resumeScan');
    if (!video.srcObject) {
        await initScan();
    } else {
        startScan();
    }
    showScreen('scan');
}

function pauseScan() {
    console.log('pauseScan');
    cancelAnimationFrame(animationRequest);
    animationRequest = null;
    showScreen('play');
}

async function isPlaying() {
    const response = await callApi('https://api.spotify.com/v1/me/player', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${currentToken.accessToken}` },
    });
    if (!response.ok) {
        console.error('resume, get playback state');
        throw Error('cannot get playback state');
    }
    return (await response.json())['is_playing'];
}

async function resume() {
    if (!(await isPlaying())) {
        const response = await callApi('https://api.spotify.com/v1/me/player/play', {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${currentToken.accessToken}` },
        });
        if (!response.ok) {
            console.error('cannot resume playback', response, await response.text());
            throw Error('cannot resume');
        }
    }
    document.getElementById('playBtn').hidden = true;
    document.getElementById('pauseBtn').hidden = false;
    document.getElementById('scanBtn').classList.add('animatedPlay');
}

async function pause() {
    if (await isPlaying()) {
        const response = await callApi('https://api.spotify.com/v1/me/player/pause', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${currentToken.accessToken}`,
            },
        });
        if (!response.ok) {
            console.error('cannot pause playback', response, await response.text());
            throw Error('cannot pause');
        }
    }
    document.getElementById('playBtn').hidden = false;
    document.getElementById('pauseBtn').hidden = true;
    document.getElementById('scanBtn').classList.remove('animatedPlay');
}

async function reset() {
    await pause();
    showScreen('start');
}

async function getDevices() {
    const response = await callApi('https://api.spotify.com/v1/me/player/devices', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${currentToken.accessToken}` },
    });
    if (!response.ok) {
        console.error('getDevices():', response, response.text);
        throw Error('Error fetching devices');
    }
    return (await response.json())['devices'];
}

async function initGame() {
    const devices = await getDevices();
    for (const device of devices) {
        const selected = device['is_active'];
        let option = new Option(
            `${device['name']} (${device['type']})`,
            `${device['id']}`,
            false,
            selected
        );
        if (device['is_restricted']) {
            option.disabled = true;
        }
        deviceList.options.add(option);
    }
    showScreen('start');
}

async function startGame() {
    await resumeScan();
}

async function changeDevice(event) {
    const response = await callApi('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken.accessToken}`,
        },
        body: JSON.stringify({
            device_ids: [`${event.target.value}`],
        }),
    });
    if (!response.ok) {
        console.error('changeDevice', response, await response.text());
    }
}

function logout() {
    localStorage.clear();
    window.location.reload();
}

document.getElementById('login').addEventListener('click', authorize);
document.getElementById('scanBtn').addEventListener('click', resumeScan);
document.getElementById('closeScan').addEventListener('click', pauseScan);
document.getElementById('closePlay').addEventListener('click', reset);
document.getElementById('startBtn').addEventListener('click', startGame);
document.getElementById('playBtn').addEventListener('click', resume);
document.getElementById('pauseBtn').addEventListener('click', pause);
deviceList.addEventListener('change', changeDevice);
document.getElementById('logout').addEventListener('click', logout);

(async () => {
    // install service worker
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('/service-worker.js');
        } catch (error) {
            console.error('sw registration failed', error);
        }
    }

    // check if this is an authorization callback
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
        await newToken(code);
        // remove the code from the url for correct refreshing
        const url = new URL(window.location.href);
        window.history.replaceState({}, document.title, url.origin + url.pathname);
    }
    // check if we have a (valid) currentToken
    if (currentToken.accessToken) {
        if (currentToken.expires <= Date.now()) {
            await refreshToken();
        }
        initGame();
    } else {
        showScreen('login');
    }
})();
