# Online PDF Workspace (Reader/Editor)

The **Online PDF Workspace (Reader/Editor)** is a powerful, serverless Progressive Web App (PWA) that functions as a fully integrated **PDF Reader and Editor** directly in your browser. Whether you need to quickly review, organize, or make precise edits to your documents, this tool provides a fast, intuitive, and secure environment to manage your files without leaving the edge. It’s built to be lightweight, high-performance, and completely personal.


<img width="1913" height="984" alt="image" src="https://github.com/user-attachments/assets/6a642011-7acb-4f2c-94ac-60e45bdd54b0" />


## Core Capabilities

*   **PDF Reader:** View documents with high-fidelity rendering, multi-tab navigation, and responsive controls.
*   **PDF Editor:** Annotate, comment, draw, add text, insert shapes, and embed images directly onto your PDF pages.
*   **Document Management:** Merge multiple files, delete pages, rotate layouts, and export specific page selections.
*   **Serverless Architecture:** Deployed entirely on the Cloudflare edge for lightning-fast speeds.
*   **Intelligent Cloud Sync:** Automatically saves your document state, history, and edits to Cloudflare R2 or KV storage.
*   **Version Control:** Full history support allows you to track changes and revert to previous versions of your edited documents.
*   **PWA/desktop/mobile Optimized:** Install it as a native-feeling app on your desktop or mobile device.

## Setting Up Cloudflare (Step-by-Step for Amateurs)

To get this reader and editor running, you need three main components in your Cloudflare dashboard:

### 1. Create the Worker (Your App)
*   Log into [Cloudflare](https://dash.cloudflare.com/).
*   On the left sidebar, click **Workers & Pages**.
*   Click **Create application** > **Create Worker**.
*   Name it `pdf-workspace` and click **Deploy**.
*   Once created, click **Edit code**. Paste the `worker.js` script from this repo into the editor and click **Save and Deploy**.

### 2. Create the Storage (Where files live)
*   **For R2 (For large PDF libraries):**
    *   On the left sidebar, click **R2**.
    *   Click **Create bucket** and name it (e.g., `pdf-bucket`).
    *   *Note:* Cloudflare requires a credit card on file to enable R2, but you get **10GB of storage for free** every month.
*   **For KV (For fast settings & metadata):**
    *   On the left sidebar, click **Workers & Pages** > **KV**.
    *   Click **Create namespace** and name it `pdf-storage`.

### 3. Connect Storage to your Worker (Bindings)
This links the storage to your editor:
*   Go to **Workers & Pages** and click on your `pdf-workspace` worker.
*   Go to **Settings** > **Variables & Secrets** > **Bindings**.
*   **To add R2:** Click **Add** > **R2 Bucket**. Set the variable name to exactly: `pdf_r2_library` and select your bucket.
*   **To add KV:** Click **Add** > **KV Namespace**. Set the variable name to exactly: `pdf_kv_store` and select your namespace.
*   *Note: Binding at least one of these is required to save your PDF edits.*

## Authentication (Optional)
Keep your reader/editor secure:
*   Under **Settings** > **Variables & Secrets**, add:
    *   `AUTH_USER`: Your desired username.
    *   `AUTH_PASS`: Your desired password.
*   *If left blank, your workspace will be accessible to anyone with the URL.*

## Tech Stack

*   **Frontend:** Pure Vanilla JavaScript, HTML5, and CSS3.
*   **Backend:** Serverless logic via Cloudflare Workers.
*   **Rendering:** [PDF.js](https://mozilla.github.io/pdf.js/) for high-fidelity document display.
*   **PDF Editing:** [PDF-lib](https://pdf-lib.js.org/) for powerful, on-the-fly PDF modifications.

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
