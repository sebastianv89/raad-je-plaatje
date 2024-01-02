const simpleFetch = async (request) => {
    try {
        return await fetch(request);
    } catch (err) {
        return new Response('Network error happened', {
            status: 408,
            headers: { 'Content-Type', 'text/plain' },
        });
    }
});

self.addEventListener('fetch', async (event) => {
    event.respondWith(simpleFetch(event.request));
});
