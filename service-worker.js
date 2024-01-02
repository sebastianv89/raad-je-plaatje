self.addEventListener("fetch", async (event) => {
    event.respondWith(await fetch(event.request));
});
