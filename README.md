# Online PDF Workspace

The **Online PDF Workspace** is a sleek, serverless Progressive Web App (PWA) designed for seamless PDF management directly in your browser. Whether you need to review documents on the go or perform precise annotations, this tool provides a fast, intuitive, and secure environment to view, annotate, and organize your files without leaving the edge. It’s built to be lightweight, performant, and completely personal.

## Features

*   **Serverless Architecture:** Deployed entirely on the Cloudflare edge for lightning-fast performance.
*   **Rich Annotations:** Highlight, comment, draw, add text, insert shapes, and embed images directly onto PDFs.
*   **PDF Manipulation:** Merge files, delete pages, rotate layouts, and export specific selections.
*   **Intelligent Cloud Sync:** Automatically saves your document state, history, and annotations to Cloudflare R2 or KV storage.
*   **Undo/Redo System:** Full version history support, allowing you to track changes and revert to previous states across sessions.
*   **PWA Optimized:** Installable as a native-feeling app on both desktop and mobile devices.
*   **Multi-Tab Interface:** Open and toggle between multiple PDFs in a single workspace.
*   **Responsive UI:** Designed with a clean look featuring Dark/Light modes, precise zoom controls, and touch-friendly tools.

## Prerequisites

*   A [Cloudflare](https://dash.cloudflare.com/) account.

## Installation & Deployment

1.  **Create a Cloudflare Worker:**
    *   Go to your Cloudflare Dashboard > **Workers & Pages** > **Create Application** > **Create Worker**.
    *   Name it `pdf-workspace` and deploy it.

2.  **Add the Code:**
    *   Click **Edit code** in your Worker's dashboard.
    *   Copy the `worker.js` script from this repository and paste it into the editor.
    *   Save and deploy.

3.  **Configure Storage Bindings:**
    To ensure your workspace can save files and annotations, you **must** bind storage to your Worker. Go to **Settings** > **Variables & Secrets** > **Bindings**:
    *   **For R2 Storage (Recommended):**
        *   Create an R2 Bucket in your Cloudflare dashboard.
        *   *Note:* Cloudflare requires a credit card on file to enable R2, but it is extremely cost-effective and includes a **generous 10GB of monthly storage for free**.
        *   Add an **R2 Bucket binding**. Set the variable name to exactly: `pdf_r2_library`
    *   **For KV Storage (Fast key-value access):**
        *   Create a KV Namespace.
        *   Add a **KV Namespace binding**. Set the variable name to exactly: `pdf_kv_store`
    *   **Pro Tip:** Bind *both* if you want maximum flexibility and performance. The system automatically detects and uses your bindings.

4.  **Set Up Authentication (Optional):**
    Keep your workspace secure by adding basic authentication. Under **Settings** > **Variables & Secrets**, add:
    *   `AUTH_USER`: Your desired username.
    *   `AUTH_PASS`: Your desired password.
    *   *Note: If these variables are left blank, your workspace will be accessible to anyone with the URL.*

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
