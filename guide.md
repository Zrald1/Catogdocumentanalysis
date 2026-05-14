# Llama.cpp Embedding Setup Guide

This guide explains how to run your local embedding models using the `llama-server` binary, enabling the CATOG Intelligent Enterprise Solution application to use fully local vector embeddings.

## Requirements

1. **llama.cpp / llama-server**
   You must have `llama-server` installed and available in your system's PATH. (For example, installed via Homebrew: `brew install llama.cpp` or built from source).
2. **GGUF Embedding Model**
   You need an embedding model in the `.gguf` format. A commonly used and high-quality embedding model is **nomic-embed-text-v1.5**. 
   We have downloaded it to `~/models/nomic-embed-text-v1.5.Q4_K_M.gguf` for your convenience.

## Starting the Server

To launch the `llama-server` locally with your embedding model, open a new terminal and run the following command:

```bash
llama-server -m ~/models/nomic-embed-text-v1.5.Q4_K_M.gguf --port 8080 --embedding --host 127.0.0.1
```

### Explanation of the Arguments:
* `-m ~/models/...`: Specifies the path to the model you are loading.
* `--port 8080`: Defines the port on which the server will listen. This must match your knowledge base configuration in the CATOG app.
* `--embedding`: **Crucial Flag!** Tells `llama-server` to operate in embedding mode instead of text generation mode.
* `--host 127.0.0.1`: Ensures the server listens only on localhost for security and reliability.

## Configuring in the CATOG App

Once the `llama-server` is running, open the CATOG application and navigate to your **Knowledge Base Settings**:

1. Click on your active Knowledge Base config.
2. Ensure the **Embedder Provider** is set to `openai-compatible` (or Local).
3. Set the **Base URL** to `http://127.0.0.1:8080/v1`.
4. Ensure the **Model** is selected as `nomic-embed-text-v1.5` (or whatever model you are running).
5. Click **Test Connection** to ensure the desktop app successfully connects to your `llama-server`.

## Stopping the Server
When you are done testing or using the local embeddings, you can stop the server by pressing `Ctrl + C` in the terminal where it is running.