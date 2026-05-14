# Local LLM & Embedding Setup for CATOG

This guide outlines the steps taken to install **llama.cpp**, **LobsterTrap**, and the **Nomic Embedding Model** on your PC to enable local intelligence for the CATOG Enterprise Solution.

## 🛠️ Components Installed

1.  **llama.cpp**: Cloned from GitHub and built from source.
2.  **LobsterTrap**: Built from source as a security proxy.
3.  **Nomic Embed Text v1.5**: Optimized embedding model for local RAG.

## 📁 File Locations

*   **llama.cpp Source**: `./llama.cpp-src`
*   **LobsterTrap Binary**: `./lobstertrap-main/lobstertrap.exe`
*   **Embedding Model**: `./models/nomic-embed-text-v1.5.Q4_K_M.gguf`

## 🚀 How to Run the Local Environment

I have integrated start scripts into your `package.json` for convenience.

### Start Everything (Recommended)
This will start both the llama server and the LobsterTrap proxy in parallel:
```bash
npm run start:local-ai
```

### Start Individually
*   **Llama Server only**: `npm run start:llama`
*   **LobsterTrap only**: `npm run start:lobstertrap`

## 🔄 Configuration Details

*   **Llama Server**: Runs on `http://localhost:8001`
*   **LobsterTrap Proxy**: Listens on `http://localhost:8080` and forwards to the Llama Server.
*   **CATOG**: Should be configured to use `http://127.0.0.1:8080/v1` as the Local AI endpoint.

## ✅ Verification
Once the services are running, you can verify the connection in the CATOG Configuration Modal by clicking "Test Connection" under the Knowledge Base settings.
