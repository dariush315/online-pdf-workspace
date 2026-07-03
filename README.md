# Cloud PDF Workspace

A serverless Progressive Web App (PWA) for viewing, annotating, and managing PDFs. Built to run entirely on Cloudflare Workers using PDF.js and PDF-lib, with automatic cloud syncing via Cloudflare R2 or KV storage.

## Features

* **Serverless Architecture:** Runs entirely on the edge using a single Cloudflare Worker script.
* **Rich Annotations:** Highlight, comment, draw, add text, insert shapes, and embed images directly onto PDFs.
* **PDF Manipulation:** Merge multiple PDFs, delete specific pages, rotate pages, and export selections.
* **Cloud Sync & Storage:** Automatically saves document state and annotations to Cloudflare R2 (recommended) or KV storage.
* **Undo/Redo System:** Full version history with cross-session undo/redo support.
* **PWA Ready:** Installable as a native app on desktop and mobile devices.
* **Multi-Tab Interface:** Open and switch between multiple PDFs seamlessly.
* **Responsive UI:** Dark/Light modes, custom zoom controls, and touch-optimized tools for mobile users.

## Prerequisites

* A [Cloudflare](https://dash.cloudflare.com/) account.
* A Cloudflare Worker.
* An R2 Bucket (recommended) and/or a KV Namespace for storage.

## Installation & Deployment

1. **Create a Cloudflare Worker:**
   * Go to Cloudflare Dashboard > Workers & Pages > Create Application > Create Worker.
   * Name it `pdf-workspace` and deploy.

2. **Add the Code:**
   * Click **Edit code**.
   * Copy the entire `worker.js` script from this repository and paste it into the editor.
   * Save and deploy.

3. **Configure Storage Bindings:**
   * Go to your Worker's **Settings** > **Variables & Secrets** > **Bindings**.
   * **Option 1: R2 Storage (Recommended)**
     * Add an R2 Bucket binding.
     * Set the Variable name to exactly: `pdf_r2_library`
   * **Option 2: KV Storage**
     * Add a KV Namespace binding.
     * Set the Variable name to exactly: `pdf_kv_store`

4. **Set Up Authentication (Optional but Recommended):**
   * Under **Settings** > **Variables & Secrets**, add the following environment variables (Plain text or Secret):
     * `AUTH_USER`: Your desired login username.
     * `AUTH_PASS`: Your desired login password.
   * If these are left blank, the workspace will be public.

## Tech Stack

* **Frontend:** Vanilla JavaScript, HTML5, CSS3
* **Backend:** Cloudflare Workers
* **PDF Rendering:** [PDF.js](https://mozilla.github.io/pdf.js/)
* **PDF Manipulation:** [PDF-lib](https://pdf-lib.js.org/)

## License

This project is licensed under the MIT License.
