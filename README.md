# Online PDF Workspace

The **Online PDF Workspace** is a sleek, serverless Progressive Web App (PWA) designed for seamless PDF management directly in your browser. Whether you need to review documents on the go or perform precise annotations, this tool provides a fast, intuitive, and secure environment to view, annotate, and organize your files without leaving the edge.

## Features

*   **Serverless Architecture:** Deployed entirely on the Cloudflare edge for lightning-fast performance.
*   **Rich Annotations:** Highlight, comment, draw, add text, insert shapes, and embed images directly onto PDFs.
*   **PDF Manipulation:** Merge files, delete pages, rotate layouts, and export specific selections.
*   **Intelligent Cloud Sync:** Automatically saves your document state, history, and annotations to Cloudflare R2 or KV storage.
*   **Undo/Redo System:** Full version history support, allowing you to track changes and revert to previous states across sessions.
*   **PWA Optimized:** Installable as a native-feeling app on both desktop and mobile devices.
*   **Multi-Tab Interface:** Open and toggle between multiple PDFs in a single workspace.
*   **Responsive UI:** Designed with a clean look featuring Dark/Light modes, precise zoom controls, and touch-friendly tools.

## Setting Up Cloudflare (Step-by-Step for Amateurs)

To get this workspace running, you need three main components in your Cloudflare dashboard:

### 1. Create the Worker (Your App)
*   Log into [Cloudflare](https://dash.cloudflare.com/).
*   On the left sidebar, click **Workers & Pages**.
*   Click **Create application** > **Create Worker**.
*   Give it a name (e.g., `pdf-workspace`) and click **Deploy**.
*   Once created, click **Edit code**. Paste the `worker.js` script from this repo into the editor and click **Save and Deploy**.

### 2. Create the Storage (Where files live)
*   **R2 (For large files):**
    *   On the left sidebar, click **R2**.
    *   Click **Create bucket** and name it something like `pdf-r2`.
    *   *Note:* Cloudflare requires a credit card on file to enable R2, but you get **10GB of storage for free** every month, which is plenty for thousands of PDFs.
*   **KV (For settings & light data):**
    *   On the left sidebar, click **Workers & Pages** > **KV**.
    *   Click **Create namespace** and name it `pdf-kv`.

### 3. Connect Storage to your Worker (Bindings)
This tells your Worker where to save your data:
*   Go back to **Workers & Pages** and click on your `pdf-workspace` worker.
*   Go to **Settings** > **Variables & Secrets** > **Bindings**.
*   **To add R2:** Click **Add** > **R2 Bucket**. Set the Variable name to EXACTLY: `pdf_r2_library` and select the bucket you created.
*   **To add KV:** Click **Add** > **KV Namespace**. Set the Variable name to EXACTLY: `pdf_kv_store` and select your namespace.
*   *You must bind at least one of these for the app to function.*

## Authentication (Optional)
Keep your workspace secure:
*   Under **Settings** > **Variables & Secrets**, add:
    *   `AUTH_USER`: Your desired username.
    *   `AUTH_PASS`: Your desired password.
*   *If left blank, the workspace will be public.*

## Tech Stack

*   **Frontend:** Pure Vanilla JavaScript, HTML5, and CSS3.
*   **Backend:** Serverless logic via Cloudflare Workers.
*   **Rendering:** [PDF.js](https://mozilla.github.io/pdf.js/) for high-fidelity document display.
*   **Manipulation:** [PDF-lib](https://pdf-lib.js.org/) for powerful, on-the-fly PDF modifications.

## Acknowledgements

*   This project was developed with the assistance of [Gemini](https://gemini.google.com/), an AI collaborator by Google, which helped with code structure, logic, and debugging.

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tr>
    <td align="center"><a href="https://gemini.google.com/"><img src="https://avatars.githubusercontent.com/u/1342004?v=4" width="100px;" alt="Gemini"/><br /><sub><b>Gemini (AI)</b></sub></a><br /><a href="#" title="Code">💻</a></td>
  </tr>
</table>
<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

## License

This project is licensed under the MIT License.
