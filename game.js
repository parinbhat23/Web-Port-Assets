const loading = document.getElementById("loading");
const canvas = document.getElementById("canvas");
const musicChoice = document.getElementById("music-choice");

// ===============================
// MUSIC CHOICE (no storage API)
// ===============================
const wantMusic = await new Promise((resolve) => {
	musicChoice.style.display = "";

	document.getElementById("btn-no-music").onclick = () => {
		musicChoice.style.display = "none";
		resolve(false);
	};

	document.getElementById("btn-with-music").onclick = () => {
		musicChoice.style.display = "none";
		resolve(true);
	};
});
musicChoice.style.display = "none";

// ===============================
// DOWNLOAD TAR (no caching)
// ===============================
async function getTar(baseName, label) {
	loading.textContent = `Downloading ${label}...`;

	const countRes = await fetch(baseName + ".count");
	if (!countRes.ok) throw new Error(`Failed to fetch ${baseName}.count`);

	const chunkCount = parseInt(await countRes.text());
	if (isNaN(chunkCount)) throw new Error(`Invalid chunk count for ${baseName}`);

	const chunks = [];
	let received = 0;

	for (let i = 0; i < chunkCount; i++) {
		const url = `${baseName}${String(i).padStart(2, "0")}`;
		const res = await fetch(url);

		if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

		const reader = res.body.getReader();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			chunks.push(value);
			received += value.length;

			loading.textContent =
				`Downloading ${label}... ${(received / 1048576) | 0} MB`;
		}
	}

	const tar = new Uint8Array(received);
	let offset = 0;

	for (const chunk of chunks) {
		tar.set(chunk, offset);
		offset += chunk.length;
	}

	return tar;
}

// ===============================
// START DOWNLOAD + RUNTIME
// ===============================
const contentPromise = getTar("Content.tar", "game content");

const bootRuntime = async () => {
	// IMPORTANT: absolute CDN path
	const { dotnet } = await import(
		"https://cdn.jsdelivr.net/gh/parinbhat23/Web-Port-Assets/_framework/dotnet.js"
	);

	return dotnet
		.withModuleConfig({ canvas })
		.withEnvironmentVariable("MONO_SLEEP_ABORT_LIMIT", "99999")
		.withRuntimeOptions([
			`--jiterpreter-minimum-trace-hit-count=${500}`,
			`--jiterpreter-trace-monitoring-period=${100}`,
			`--jiterpreter-trace-monitoring-max-average-penalty=${150}`,
			`--jiterpreter-wasm-bytes-limit=${64 * 1024 * 1024}`,
			`--jiterpreter-table-size=${32 * 1024}`,
			"--jiterpreter-stats-enabled",
		])
		.withResourceLoader((type, _name, defaultUri, _integrity, behavior) => {
			if (type === "dotnetwasm" && behavior === "dotnetwasm") {
				return (async () => {
					const countRes = await fetch(defaultUri + ".count");
					const count = parseInt(await countRes.text());

					let idx = 0;

					const fetchNext = async () => {
						if (idx >= count) return null;

						const res = await fetch(defaultUri + idx);
						idx++;

						if (!res.ok) return null;
						return res.body.getReader();
					};

					let current = await fetchNext();
					if (!current) throw new Error("Failed to fetch WASM");

					const stream = new ReadableStream({
						async pull(controller) {
							const { value, done } = await current.read();

							if (done || !value) {
								current = await fetchNext();

								if (current) {
									await this.pull(controller);
								} else {
									controller.close();
								}
							} else {
								controller.enqueue(value);
							}
						},
					});

					return new Response(stream, {
						headers: { "Content-Type": "application/wasm" },
					});
				})();
			}
		})
		.create();
};

const runtimePromise = bootRuntime();

// ===============================
// WAIT FOR BOTH
// ===============================
const [contentTar, runtime] = await Promise.all([
	contentPromise,
	runtimePromise,
]);

const config = runtime.getConfig();
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);

await runtime.runMain();
await exports.WasmBootstrap.PreInit();

// ===============================
// TAR EXTRACTION
// ===============================
function extractTar(tar, prefix) {
	let pos = 0;

	function readString(buf, off, len) {
		let end = off;
		while (end < off + len && buf[end] !== 0) end++;
		return new TextDecoder().decode(buf.subarray(off, end));
	}

	function readOctal(buf, off, len) {
		const s = readString(buf, off, len).trim();
		return s ? parseInt(s, 8) : 0;
	}

	while (pos + 512 <= tar.length) {
		const header = tar.subarray(pos, pos + 512);
		if (header.every((b) => b === 0)) break;

		const name = readString(header, 0, 100);
		const size = readOctal(header, 124, 12);
		const typeFlag = header[156];
		const pref = readString(header, 345, 155);
		const fullName = pref ? pref + "/" + name : name;

		pos += 512;

		if (typeFlag === 53 || name.endsWith("/")) {
			exports.WasmBootstrap.CreateContentDirectory(prefix + fullName);
		} else {
			exports.WasmBootstrap.WriteContentFile(
				prefix + fullName,
				tar.subarray(pos, pos + size)
			);
		}

		pos += Math.ceil(size / 512) * 512;
	}
}

// ===============================
// LOAD FILES
// ===============================
loading.textContent = "Loading game files...";
extractTar(contentTar, "/libsdl/");

if (wantMusic) {
	const audioTar = await getTar("ContentAudio.tar", "music");
	loading.textContent = "Loading music...";
	extractTar(audioTar, "/libsdl/");
}

loading.classList.add("hidden");

// ===============================
// INIT CANVAS
// ===============================
const dpr = window.devicePixelRatio || 1;
let w = Math.round(canvas.clientWidth * dpr);
let h = Math.round(canvas.clientHeight * dpr);
if (w === 0 || h === 0) {
	w = 1280;
	h = 720;
}

await exports.WasmBootstrap.Init(w, h);

// ===============================
// RESIZE HANDLING
// ===============================
new ResizeObserver(() => {
	const dpr = window.devicePixelRatio || 1;
	const nw = Math.round(canvas.clientWidth * dpr);
	const nh = Math.round(canvas.clientHeight * dpr);

	if (nw > 0 && nh > 0) {
		try {
			exports.WasmBootstrap.Resize(nw, nh);
		} catch {}
	}
}).observe(canvas);

// ===============================
// INPUT FIXES
// ===============================
try {
	navigator.keyboard?.lock();
} catch {}

document.addEventListener("keydown", (e) => {
	if (
		["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)
	) {
		e.preventDefault();
	}
});

// ===============================
// START GAME LOOP
// ===============================
await exports.WasmBootstrap.MainLoop();
