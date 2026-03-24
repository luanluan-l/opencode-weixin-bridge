# opencode-weixin-bridge

Bridge opencode to WeChat via ilink bot protocol.

## Features

- Connect opencode to WeChat via ilink bot
- QR code login support
- LLM integration for message handling
- TypeScript implementation

## Prerequisites

- Node.js >= 22

## Installation

```bash
npm install
```

## Usage

### List All Sessions

List all OpenCode sessions:

```bash
npm run list-sessions
```

### Login

First, authenticate with WeChat by scanning a QR code:

```bash
npm run login
```

Scan the QR code with WeChat to complete authentication. Credentials will be stored locally.

### Run the Bot

Set your LLM API key and start the bot:

```bash
OPENAI_API_KEY=sk-xxx npm run dev
```

Or use command-line arguments:

```bash
npm run dev -- --api-key sk-xxx --model gpt-4o
```

### Configuration

You can configure the bot using environment variables or command-line arguments:

| Variable | Argument | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | `--api-key` | (required) | LLM API key |
| `LLM_MODEL` | `--model` | `gpt-4o` | LLM model name |
| `OPENAI_BASE_URL` | `--api-url` | `https://api.openai.com/v1/chat/completions` | LLM API base URL |

### Build

```bash
npm run build
```

## Scripts

- `npm run dev` - Start the bot in development mode
- `npm run login` - Login with QR code
- `npm run build` - Build the project
- `npm start` - Start the built bot

## License

MIT
