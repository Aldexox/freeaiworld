# OmniFree AI Studio

A clean, minimal web workspace for accessing **free AI models around the world** for **Coding**, **Writing**, and **Image Creation** — with **Gemini-style live token streaming** and a **built-in Terminal & Live Result Workbench**.

## Highlights

- **Real-Time Streaming Output**: Responses type out live token-by-token as the AI processes, with a live cursor and a **Stop** button to interrupt anytime.
- **Built-in Terminal & Live Result Workbench**:
  - **HTML / CSS / JS**: Renders live inside the **Result** pane and pipes `console.log` / errors into the **Terminal**.
  - **Python**: Executes directly on the local Python 3 runner and displays `stdout`, `stderr`, exit code, and timing in the **Terminal**.
  - **JavaScript**: Runs in an isolated sandboxed worker (or local Node.js if installed) and prints output to the **Terminal**.
  - **SQL**: Executes against an in-memory SQLite database and renders formatted result tables in the **Terminal**.
- **Global Free AI Models**:
  - **Instant No-Key Mode**: Pollinations.ai for text, coding, and FLUX/Turbo images.
  - **Live OpenRouter `:free` Sync** + **Google Gemini**, **Groq**, **Cerebras**, **Mistral**, **GitHub Models**, **Hugging Face**, and **Local Ollama**.

## Quick Start

1. Double-click `start.bat` or run:
   ```bash
   python server.py
   ```
2. Open `http://127.0.0.1:8787` in your browser.
