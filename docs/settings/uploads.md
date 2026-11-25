# File uploads

Horizon Lounge supports authenticated local file hosting with optional auto-deletion as well as direct uploads to third-party image and file hosts.

## Server setup (`config.js`)

File uploads are disabled by default. Turn them on in `${THELOUNGE_HOME}/config.js` and restart:

```js
fileUpload: {
	enable: true,
	maxFileSize: 10240, // in KB (10 MB). -1 disables the limit.
	baseUrl: null,      // optional custom URL prefix when proxying /uploads
},
allowFileUploadBackendSelection: true,
maskFileHost: false,
```

| Option                            | Default | What it does                                                                                                                                      |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileUpload.enable`               | `false` | Enables drag-and-drop and the upload dialog for authenticated users.                                                                              |
| `fileUpload.maxFileSize`          | `10240` | Maximum upload size in KB (`-1` for unlimited).                                                                                                   |
| `fileUpload.baseUrl`              | `null`  | Rewrites generated upload URLs (for example `"https://files.example.com/"`). Ensure your reverse proxy forwards that path back to Horizon Lounge. |
| `allowFileUploadBackendSelection` | `true`  | Allows users to pick an external upload provider in **Settings → General**. Set to `false` to restrict users to local hosting.                    |
| `maskFileHost`                    | `false` | Replaces the hostname of external upload URLs with `fileUpload.baseUrl` if you proxy external hosts yourself.                                     |

::: info Authentication requirement
Unlike older builds where upload URLs could be probed unauthenticated, Horizon Lounge requires an active logged-in session to upload files.
:::

## Choosing a backend (Client settings)

Open **Settings → General → File uploads** to configure how your browser uploads files:

1. **Strip image metadata** (`uploadCanvas`): Re-renders images onto a `<canvas>` before upload to strip EXIF metadata (may affect orientation on some browsers).
2. **Upload Backend**: Choose local storage or an external provider.
3. **API URL & API Key**: Shown when the selected provider requires a custom endpoint or token.
4. **Upload TTL**: Controls expiration when supported by the provider.

### Supported upload providers

| Provider              | API Key  | Custom URL | Supported TTL options                                             | Notes                                                                  |
| --------------------- | -------- | ---------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **TheLounge (Local)** | No       | No         | Never, 1 Hour, 12 Hours, 1 Day, 1 Week, 1 Month, Custom (seconds) | Stored in `${THELOUNGE_HOME}/uploads`; expired files are swept hourly. |
| **Catbox**            | Optional | No         | Keep Forever, 1 Day, 3 Days                                       | Images, videos, audio, and text.                                       |
| **ImageBB**           | Yes      | No         | Keep Forever, 1 Day, 3 Days, 1 Week                               | Images.                                                                |
| **PTScreens**         | Yes      | No         | Keep Forever, 1 Day, 3 Days, 1 Week                               | Images.                                                                |
| **qu.ax**             | No       | No         | Keep Forever, 1 Day, 3 Days, 1 Week                               | Images, video, and text.                                               |
| **Uguu**              | No       | No         | 3 Hours                                                           | Images, video, audio, and text.                                        |
| **OnlyImage**         | Yes      | No         | Keep Forever, 1 Day, 3 Days, 1 Week                               | Images.                                                                |
| **ptpimg**            | Yes      | No         | Keep Forever                                                      | Images.                                                                |
| **XBackBone**         | Yes      | Yes        | Server-managed                                                    | Self-hosted upload server.                                             |
| **Zipline**           | Yes      | Yes        | Server-managed                                                    | Images, videos, audio, and text.                                       |
| **rustypaste**        | Yes      | Yes        | Server Default, 1 Hour, 1 Day, 3 Days, 1 Week                     | Self-hosted pastebin/file host.                                        |

## Uploading in chat

- **Drag and drop** any file into the message input area, **paste** an image from your clipboard, or click the **upload** button in the compose bar.
- Once uploaded, the resulting link is inserted into your message box ready to send.
- If an external upload service returns an HTML error page instead of JSON/text, Horizon Lounge surfaces a readable status error instead of pasting raw HTML into your draft.
