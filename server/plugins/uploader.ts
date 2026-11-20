import Config from "../config.js";
import busboy, {BusboyHeaders} from "@fastify/busboy";
import path from "node:path";
import fs from "node:fs";
import {fileTypeFromBuffer} from "file-type";
import {readChunk} from "read-chunk";
import crypto from "node:crypto";
import log from "../log.js";
import contentDisposition from "content-disposition";
import type {Socket} from "socket.io";
import {Application, Request, Response} from "express";
import mime from "mime";
import {UploadProviders, UploadProvider} from "../../shared/upload-providers.js";

// Map of allowed mime types to their respecive default filenames
// that will be rendered in browser without forcing them to be downloaded
const inlineContentDispositionTypes = {
	"application/ogg": "media.ogx",
	"audio/midi": "audio.midi",
	"audio/mpeg": "audio.mp3",
	"audio/ogg": "audio.ogg",
	"audio/vnd.wave": "audio.wav",
	"audio/x-flac": "audio.flac",
	"audio/x-m4a": "audio.m4a",
	"image/bmp": "image.bmp",
	"image/gif": "image.gif",
	"image/jpeg": "image.jpg",
	"image/png": "image.png",
	"image/webp": "image.webp",
	"image/avif": "image.avif",
	"image/jxl": "image.jxl",
	"text/plain": "text.txt",
	"video/mp4": "video.mp4",
	"video/ogg": "video.ogv",
	"video/webm": "video.webm",
};

const uploadTokens = new Map();

const EXPIRY_SUFFIX = ".expires";
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

class Uploader {
	constructor(socket: Socket) {
		socket.on("upload:auth", () => {
			const token = crypto.randomUUID();

			socket.emit("upload:auth", token);

			// Invalidate the token in one minute
			const timeout = Uploader.createTokenTimeout(token);

			uploadTokens.set(token, timeout);
		});

		socket.on("upload:ping", (token) => {
			if (typeof token !== "string") {
				return;
			}

			let timeout = uploadTokens.get(token);

			if (!timeout) {
				return;
			}

			clearTimeout(timeout);
			timeout = Uploader.createTokenTimeout(token);
			uploadTokens.set(token, timeout);
		});
	}

	static createTokenTimeout(this: void, token: string) {
		return setTimeout(() => uploadTokens.delete(token), 60 * 1000);
	}

	// Validates and invalidates a one-time upload token, returns whether it was valid
	static consumeToken(this: void, token: unknown) {
		if (typeof token !== "string") {
			return false;
		}

		const timeout = uploadTokens.get(token);

		if (!timeout) {
			return false;
		}

		clearTimeout(timeout);
		uploadTokens.delete(token);

		return true;
	}

	// Builds the token string the provider's upload() expects from the submitted
	// form fields. Throws if the fields are missing or invalid.
	static getProviderToken(
		this: void,
		uploadProvider: UploadProvider,
		fields: Record<string, string>
	): string | undefined {
		const apiKey = fields.apiKey ?? "";

		// The key is handed to the provider joined to the upload address with
		// this separator, a key containing it would be cut short there
		if (apiKey.includes("_|_")) {
			throw new Error("Invalid API Key");
		}

		if (uploadProvider.requiresURL) {
			let parsedURL: URL;

			try {
				parsedURL = new URL(fields.uploadURL ?? "");
			} catch {
				throw new Error("Invalid Upload URL");
			}

			if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
				throw new Error("Invalid Upload URL");
			}

			// URL.href is always ASCII, so it is safe to base64 encode
			return `${Buffer.from(parsedURL.href).toString("base64")}_|_${apiKey}`;
		}

		if (uploadProvider.requiresToken && !apiKey) {
			throw new Error("Missing API Key");
		}

		return apiKey || undefined;
	}

	// Error messages from providers may contain (parts of) the upstream response
	// body. Never reflect those for user supplied upload URLs, and keep them short
	// for the fixed public providers.
	static sanitizeProviderError(this: void, uploadProvider: UploadProvider, message: string) {
		const knownMessages = ["Invalid Upload URL", "Invalid Upload Token", "Unknown Error"];

		if (knownMessages.includes(message)) {
			return message;
		}

		if (uploadProvider.requiresURL) {
			return `Upload to ${uploadProvider.displayName} failed`;
		}

		const firstLine = message.split(/\r?\n/, 1)[0].trim();

		if (!firstLine) {
			return `Upload to ${uploadProvider.displayName} failed`;
		}

		return firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
	}

	static router(this: void, express: Application) {
		express.get("/uploads/:name{/:slug}", Uploader.routeGetFile);
		express.post("/uploads/:service/:token{/:ttl}", Uploader.routeUploadFile);
	}

	static async routeGetFile(this: void, req: Request, res: Response) {
		const name = <string>req.params.name;

		const nameRegex = /^[0-9a-f]{16}$/;

		if (!nameRegex.test(name)) {
			return res.status(404).send("Not found");
		}

		const folder = name.substring(0, 2);
		const uploadPath = Config.getFileUploadPath();
		const filePath = path.join(uploadPath, folder, name);
		let detectedMimeType = await Uploader.getFileType(filePath);

		// doesn't exist
		if (detectedMimeType === null) {
			return res.status(404).send("Not found");
		}

		// Force a download in the browser if it's not an allowed type (binary or otherwise unknown)
		let slug = <string>req.params.slug;
		const isInline = detectedMimeType in inlineContentDispositionTypes;
		let disposition = isInline ? "inline" : "attachment";

		if (!slug && isInline) {
			slug = inlineContentDispositionTypes[detectedMimeType];
		}

		if (slug) {
			disposition = contentDisposition(slug.trim(), {
				fallback: false,
				type: disposition,
			});
		}

		// Send a more common mime type for audio files
		// so that browsers can play them correctly
		if (detectedMimeType === "audio/vnd.wave") {
			detectedMimeType = "audio/wav";
		} else if (detectedMimeType === "audio/x-flac") {
			detectedMimeType = "audio/flac";
		} else if (detectedMimeType === "audio/x-m4a") {
			detectedMimeType = "audio/mp4";
		} else if (detectedMimeType === "video/quicktime") {
			detectedMimeType = "video/mp4";
		}

		res.setHeader("Content-Disposition", disposition);
		res.setHeader("Cache-Control", "max-age=86400");
		res.contentType(detectedMimeType);

		return res.sendFile(filePath);
	}

	static routeUploadFile(this: void, req: Request, res: Response) {
		let busboyInstance: InstanceType<typeof busboy> | null | undefined;
		let uploadUrl: string | URL;
		let randomName: string;
		let originalFilename: string;
		let destDir: fs.PathLike;
		let destPath: fs.PathLike | null;
		let streamWriter: fs.WriteStream | null;

		const uploadProvider = UploadProviders.find((b) => b.id === req.params.service);
		const ttl = <string>req.params.ttl ?? "";

		// Credentials for external providers are sent as multipart fields that
		// precede the file, so they never show up in the request URL (and thus in
		// access logs of reverse proxies)
		const fields: Record<string, string> = {};
		let providerToken: string | undefined;

		const doneCallback = () => {
			// detach the stream and drain any remaining data
			if (busboyInstance) {
				req.unpipe(busboyInstance);
				req.on("readable", req.read.bind(req));

				busboyInstance.removeAllListeners();
				busboyInstance = null;
			}

			// close the output file stream
			if (streamWriter) {
				streamWriter.end();
				streamWriter = null;
			}
		};

		const abortWithError = (err: unknown, status = 400) => {
			doneCallback();

			// if we ended up erroring out, delete the output file from disk
			if (destPath && fs.existsSync(destPath)) {
				fs.unlinkSync(destPath);
				destPath = null;
			}

			if (res.headersSent) {
				return;
			}

			return res
				.status(status)
				.json({error: err instanceof Error ? err.message : String(err)});
		};

		if (!uploadProvider) {
			return abortWithError(Error("Invalid upload provider"));
		}

		// Every upload, regardless of the provider, must present a valid one-time
		// token that was issued over an authenticated socket connection
		if (!Uploader.consumeToken(req.params.token)) {
			return abortWithError(Error("Invalid upload token"), 403);
		}

		if (uploadProvider.id !== "new" && !Config.values.allowFileUploadBackendSelection) {
			return abortWithError(Error("Upload provider selection is disabled"), 403);
		}

		// In public mode anyone who opens the page gets an upload token, so a
		// provider that posts to an address of the visitor's choosing would let
		// anonymous visitors make this server send requests anywhere
		if (uploadProvider.requiresURL && Config.values.public) {
			return abortWithError(
				Error("This upload provider is not available in public mode"),
				403
			);
		}

		// if the request does not contain any body data, bail out
		if (req.headers["content-length"] && parseInt(req.headers["content-length"]) < 1) {
			return abortWithError(Error("Length Required"));
		}

		// Only allow multipart, as busboy can throw an error on unsupported types
		if (!(
			req.headers["content-type"] &&
			req.headers["content-type"].startsWith("multipart/form-data")
		)) {
			return abortWithError(Error("Unsupported Content Type"));
		}

		// create a new busboy processor, it is wrapped in try/catch
		// because it can throw on malformed headers
		try {
			busboyInstance = new busboy({
				headers: req.headers as BusboyHeaders,
				limits: {
					files: 1, // only allow one file per upload
					fields: 2, // apiKey and uploadURL for external providers
					fieldSize: 4096,
					fileSize: Uploader.getMaxFileSize(),
				},
			});
		} catch (err) {
			return abortWithError(err);
		}

		// Any error or limit from busboy will abort the upload with an error
		busboyInstance.on("error", abortWithError);
		busboyInstance.on("partsLimit", () => abortWithError(Error("Parts limit reached")));
		busboyInstance.on("filesLimit", () => abortWithError(Error("Files limit reached")));
		busboyInstance.on("fieldsLimit", () => abortWithError(Error("Fields limit reached")));

		// generate a random output filename for the file
		// we use do/while loop to prevent the rare case of generating a file name
		// that already exists on disk
		do {
			randomName = crypto.randomBytes(8).toString("hex");
			destDir = path.join(Config.getFileUploadPath(), randomName.substring(0, 2));
			destPath = path.join(destDir, randomName);
		} while (fs.existsSync(destPath));

		// we split the filename into subdirectories (by taking 2 letters from the beginning)
		// this helps avoid file system and certain tooling limitations when there are
		// too many files on one folder
		try {
			fs.mkdirSync(destDir, {recursive: true});
		} catch (err: unknown) {
			log.error(
				`Error ensuring ${destDir} exists for uploads: ${err instanceof Error ? err.message : String(err)}`
			);

			return abortWithError(err);
		}

		// Open a file stream for writing
		streamWriter = fs.createWriteStream(destPath);
		streamWriter.on("error", abortWithError);

		busboyInstance.on(
			"field",
			(
				fieldname: string,
				value: string,
				_nameTruncated: boolean,
				valueTruncated: boolean
			) => {
				if (fieldname !== "apiKey" && fieldname !== "uploadURL") {
					return;
				}

				// A value cut off at the size limit must not be used as if it were whole
				if (valueTruncated) {
					return abortWithError(Error("Field too long"));
				}

				fields[fieldname] = value;
			}
		);

		busboyInstance.on(
			"file",
			(fieldname: string, fileStream: NodeJS.ReadableStream, filename: string) => {
				// Provider credentials must be sent before the file, validate them
				// before accepting any file data
				if (uploadProvider.id !== "new") {
					try {
						providerToken = Uploader.getProviderToken(uploadProvider, fields);
					} catch (err) {
						fileStream.resume();
						return abortWithError(err);
					}
				}

				uploadUrl = `${randomName}/${encodeURIComponent(filename)}`;
				originalFilename = filename;

				if (Config.values.fileUpload.baseUrl) {
					uploadUrl = new URL(uploadUrl, Config.values.fileUpload.baseUrl).toString();
				} else {
					uploadUrl = `uploads/${uploadUrl}`;
				}

				// if the busboy data stream errors out or goes over the file size limit
				// abort the processing with an error
				fileStream.on("error", abortWithError);
				fileStream.on("limit", () => {
					fileStream.unpipe(streamWriter!);
					fileStream.on("readable", fileStream.read.bind(fileStream));

					return abortWithError(Error("File size limit reached"));
				});

				// Attempt to write the stream to file
				fileStream.pipe(streamWriter!);
			}
		);

		if (uploadProvider.id === "new") {
			// local upload
			busboyInstance.on("finish", () => {
				if (!uploadUrl) {
					// also removes the empty file opened for the upload
					return abortWithError(Error("Missing file"));
				}

				doneCallback();

				Uploader.writeExpiry(<string>destPath, uploadProvider, ttl);

				// upload was done, send the generated file url to the client
				res.status(200).json({
					url: uploadUrl,
				});
			});
		} else {
			// service upload
			busboyInstance.on("finish", () => {
				if (!originalFilename) {
					return abortWithError(Error("Missing file"));
				}

				const upload = () => {
					const file = new File(
						[new Blob([fs.readFileSync(<string>destPath)])],
						originalFilename,
						{
							type: mime.getType(originalFilename) ?? undefined,
						}
					);

					uploadProvider
						.upload(file, ttl, providerToken)
						.then((url) => {
							fs.unlink(<string>destPath, () => undefined);

							uploadUrl = url;

							// Allow host masking to allow vanity url for external hosted images
							if (
								Config.values.maskFileHost &&
								// eslint-disable-next-line eqeqeq
								Config.values.fileUpload.baseUrl != null
							) {
								const oldHost = new URL(url).host;
								const newHost = new URL(Config.values.fileUpload.baseUrl).host;

								uploadUrl = url.replace(oldHost, newHost);
							}

							if (!uploadUrl) {
								return res.status(400).json({error: "Missing file"});
							}

							// upload was done, send the generated file url to the client
							return res.status(200).json({
								url: uploadUrl,
							});
						})
						.catch((err: unknown) => {
							const message = err instanceof Error ? err.message : String(err);
							log.debug(`Upload to ${uploadProvider.id} failed: ${message}`);
							abortWithError(
								Error(Uploader.sanitizeProviderError(uploadProvider, message))
							);
						});
				};

				if (!streamWriter || streamWriter.closed === true) {
					upload();
				} else {
					streamWriter?.once("finish", upload);
				}

				doneCallback();
			});
		}

		// pipe request body to busboy for processing
		return req.pipe(busboyInstance);
	}

	// Records an expiry timestamp for a locally stored upload, if a valid TTL was requested.
	// Predefined TTL entries carry their duration in seconds. The "custom" option has no
	// fixed duration of its own - the client sends the user-entered seconds value in its
	// place, which won't match any entry's id.
	static writeExpiry(this: void, filePath: string, uploadProvider: UploadProvider, ttl: string) {
		const ttlEntry = uploadProvider.validTtl?.find((t) => t.id === ttl);
		let ttlSeconds: number;

		if (ttlEntry) {
			if (ttlEntry.value === "-" || ttlEntry.id === "custom") {
				return;
			}

			ttlSeconds = parseInt(ttlEntry.value, 10);
		} else {
			ttlSeconds = parseInt(ttl, 10);
		}

		if (Number.isNaN(ttlSeconds) || ttlSeconds <= 0) {
			return;
		}

		const expiresAt = Date.now() + ttlSeconds * 1000;

		try {
			fs.writeFileSync(`${filePath}${EXPIRY_SUFFIX}`, String(expiresAt));
		} catch (err: unknown) {
			log.warn(
				`Failed to write expiry metadata for ${filePath}: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	// Scans the upload folder for expired local uploads and removes them
	static pruneExpiredUploads(this: void) {
		const uploadPath = Config.getFileUploadPath();
		let subDirs: string[];

		try {
			subDirs = fs.readdirSync(uploadPath);
		} catch {
			return;
		}

		const now = Date.now();

		for (const subDir of subDirs) {
			const dirPath = path.join(uploadPath, subDir);
			let entries: string[];

			try {
				entries = fs.readdirSync(dirPath);
			} catch {
				continue;
			}

			for (const entry of entries) {
				if (!entry.endsWith(EXPIRY_SUFFIX)) {
					continue;
				}

				const expiryPath = path.join(dirPath, entry);
				const filePath = expiryPath.slice(0, -EXPIRY_SUFFIX.length);

				let expiresAt: number;

				try {
					expiresAt = parseInt(fs.readFileSync(expiryPath, "utf8"), 10);
				} catch {
					continue;
				}

				if (Number.isNaN(expiresAt) || expiresAt > now) {
					continue;
				}

				fs.rmSync(filePath, {force: true});
				fs.rmSync(expiryPath, {force: true});

				log.info(`Removed expired upload: ${filePath}`);
			}

			// Remove the containing folder if it's now empty (also cleans up
			// any other empty upload folders found along the way)
			try {
				if (fs.readdirSync(dirPath).length === 0) {
					fs.rmdirSync(dirPath);
				}
			} catch {
				// not empty, or already removed - ignore
			}
		}
	}

	// Starts the periodic sweep that removes local uploads past their TTL
	static startExpiryCleanup(this: void) {
		Uploader.pruneExpiredUploads();
		setInterval(Uploader.pruneExpiredUploads, CLEANUP_INTERVAL).unref();
	}

	static getMaxFileSize() {
		const configOption = Config.values.fileUpload.maxFileSize;

		// Busboy uses Infinity to allow unlimited file size
		if (configOption < 1) {
			return Infinity;
		}

		// maxFileSize is in bytes, but config option is passed in as KB
		return configOption * 1024;
	}

	// Returns null if an error occurred (e.g. file not found)
	// Returns a string with the type otherwise
	static async getFileType(filePath: string) {
		try {
			const buffer = await readChunk(filePath, {length: 5120, startPosition: 0});

			// returns {ext, mime} if found, null if not.
			const file = await fileTypeFromBuffer(buffer);

			// if a file type was detected correctly, return it
			if (file) {
				return file.mime;
			}

			// if the buffer is a valid UTF-8 buffer, use text/plain
			try {
				new TextDecoder("utf-8", {fatal: true}).decode(buffer);
				return "text/plain";
			} catch {
				// Not valid UTF-8, continue to detect as binary
			}

			// otherwise assume it's random binary data
			return "application/octet-stream";
		} catch (e: unknown) {
			if (e && typeof e === "object" && "code" in e && e.code !== "ENOENT") {
				const message = e instanceof Error ? e.message : "unknown error";
				log.warn(`Failed to read ${filePath}: ${message}`);
			}
		}

		return null;
	}
}

export default Uploader;
