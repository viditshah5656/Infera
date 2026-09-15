# Infera — No-Clone Setup

Infera can be used without cloning the repository. The supported user flow is:

1. Open the public workspace: https://viditshah5656.github.io/Infera/
2. Download the platform installer.
3. Run the installer once. It downloads the current Infera source archive, prepares the local Python and Node runtimes, installs dependencies, and starts the local gateway.
4. Return to the workspace. It discovers `http://127.0.0.1:8081` and loads the available models.
5. Chat, inspect `/v1/models`, test `/v1/chat/completions`, and connect OpenAI-compatible applications locally.

## Windows

From the workspace download `install.ps1`, then run it from PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

The installer places Infera under `%LOCALAPPDATA%\\Infera` and creates `Start-Infera.cmd`.

## macOS / Linux

Download `install.sh`, then:

```bash
chmod +x install.sh
./install.sh
```

The local runtime is placed under `~/.local/share/infera`.

## Privacy boundary

The hosted GitHub Pages application is a static control surface. Chat traffic is sent directly from the browser to the locally running gateway at `127.0.0.1:8081`; the hosted site is not an inference proxy.

Do not expose the local gateway to a network unless you intentionally configure authentication, TLS, and appropriate access controls.

## When to clone

Cloning is only useful when you want to develop, modify, build, or contribute to the Infera source itself.
