const CLIENT_ID = 'e23eaf2e6b4f416b98d71c64d3bfa899'; 

const gotTokenEvent = new Event('gotToken');
const video = document.createElement('video');
const canvasElement = document.getElementById('playback');
const canvas = canvasElement.getContext('2d', {
    willReadFrequently: true,
});
const loginScreen = document.getElementById('loginScreen');
const scanScreen = document.getElementById('scanScreen');
const playScreen = document.getElementById('playScreen');
let animationRequest = null;

// Data structure for managing tokens
const currentToken = {
    get accessToken() { return localStorage.getItem('accessToken') || null; },
    get refreshToken() { return localStorage.getItem('refreshToken') || null; },
    save: (response) => {
        const { access_token, refresh_token } = response;
        localStorage.setItem('accessToken', access_token);
        localStorage.setItem('refreshToken', refresh_token);
        window.dispatchEvent(gotTokenEvent);
    }
};

function showScreen(name) {
    loginScreen.style.display = 'none';
    scanScreen.style.display = 'none';
    playScreen.style.display = 'none';
    if (name === 'scan') {
        scanScreen.style.display = 'flex';
    } else if (name === 'play') {
        playScreen.style.display = 'flex';
    } else {
        loginScreen.style.display = 'flex';
    }
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
        scope: 'streaming user-read-email user-read-private user-modify-playback-state',
        code_challenge_method: 'S256',
        code_challenge: code_challenge,
    }).toString();
    window.location.href = authUrl.toString();
}

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
        throw Error('error refreshing token');
    }
    currentToken.save(await response.json());
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
    return response.ok;
}

async function scan() {
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
                console.log('gotTrack, stopping scan');
                play();
                stopScan();
                return;
            }
            console.log('continuing?');
        }
    }
    animationRequest = requestAnimationFrame(scan);
}

async function startScan() {
    console.log('startScan');
    showScreen('scan');
    navigator.mediaDevices.getUserMedia({ video: true, facingMode: 'environment' })
        .then((stream) => {
            video.srcObject = stream;
            video.addEventListener('canplay', () => {
                video.play();
                requestAnimationFrame(scan);
            });
        })
        .catch((err) => {
            console.error(err);
            cam.innerHTML = `Webcam not available: ${err}`;
        });
}

function stopScan() {
    console.log('stopScan');
    cancelAnimationFrame(animationRequest);
    animationRequest = null;
    showScreen('play');
}

function play() {
    document.getElementById('play').hidden = true;
    document.getElementById('pause').hidden = false;
    document.getElementById('scan').classList.add('animatedPlay');
    window.player.resume();
}

function pause() {
    document.getElementById('play').hidden = false;
    document.getElementById('pause').hidden = true;
    document.getElementById('scan').classList.remove('animatedPlay');
    window.player.pause();
}

function initPlayer() {
    console.log('initPlayer');
    showScreen('scan');
    console.assert(currentToken.accessToken !== null);
    window.player = new Spotify.Player({
        name: 'Raad je plaatje',
        getOAuthToken: cb => { cb(currentToken.accessToken); }
    });
    window.player.addListener('ready', async function ({ device_id }) {
        console.log('player ready', device_id);
        // transfer playback to current device
        await callApi('https://api.spotify.com/v1/me/player', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${currentToken.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                device_ids: [ device_id ],
            }),
        });
        document.getElementById('play').addEventListener('click', play);
        document.getElementById('pause').addEventListener('click', pause);
        document.getElementById('scan').addEventListener('click', pause);
    });
    window.player.addListener('authentication_error', async () => {
        window.player.removeListener('authentication_error'); // avoid an infinite loop
        await refreshToken();
        window.player.connect();
    });
    window.player.connect();
    window.removeEventListener('gotToken', initPlayer);
    startScan();
}

window.onSpotifyWebPlaybackSDKReady = () => {
    if (currentToken.accessToken === null) {
        window.addEventListener('gotToken', initPlayer);
    } else {
        initPlayer();
    }
};

document.getElementById('login').addEventListener('click', authorize);
document.getElementById('scan').addEventListener('click', startScan);
document.getElementById('closeScan').addEventListener('click', stopScan);
document.getElementById('logout').addEventListener('click', () => {
    player.disconnect();
    localStorage.clear(); 
    window.location.reload();
});

(async () => {
    // check if this is an authorization callback
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
        await newToken(code);
        // remove the code from the url for correct refreshing
        const url = new URL(window.location.href);
        window.history.replaceState({}, document.title, url.origin + url.pathname);
    }
})();
