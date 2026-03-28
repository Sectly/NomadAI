# NomadAI — VM Setup Guide

This guide walks through creating a VirtualBox VM, installing Ubuntu Server, and running NomadAI inside it — including how to access the observer panel from your host machine.

---

## 1. Install VirtualBox

Download and install VirtualBox for your host OS:
- https://www.virtualbox.org/wiki/Downloads

Also install the **VirtualBox Extension Pack** from the same page — it adds USB 2.0/3.0, clipboard sharing, and better display support.

---

## 2. Download Ubuntu Server LTS

Get the latest Ubuntu Server LTS ISO (24.04 Noble is recommended):
- https://ubuntu.com/download/server

> Debian 12 (Bookworm) also works. This guide uses Ubuntu Server 24.04.

---

## 3. Create the VM

Open VirtualBox → **New**

| Setting | Value |
|---------|-------|
| Name | `NomadAI` |
| Type | Linux |
| Version | Ubuntu (64-bit) |
| Memory | **4096 MB minimum** (8192 MB recommended if running a larger model) |
| CPU cores | **2 minimum** (4 recommended) |
| Hard disk | **40 GB minimum** (VDI, dynamically allocated) |

Click **Finish**.

---

## 4. Configure VM settings

Right-click the VM → **Settings**

### System → Processor
- Enable **PAE/NX**
- Enable **VT-x / AMD-V** (should be on by default)

### Display
- Video Memory: **32 MB** (more if you plan to use a desktop)
- Acceleration: enable **3D Acceleration** (optional)

### Storage
- Click the empty optical drive → assign the Ubuntu Server ISO you downloaded

### Network
Two network adapters are needed — one for internet access during setup, one for stable host access to the observer panel.

**Adapter 1** (internet access):
- Attached to: **NAT**
- This gives the VM outbound internet so it can download Ollama, Bun, and models

**Adapter 2** (host ↔ VM access):
- Enable the adapter
- Attached to: **Host-Only Adapter**
- Name: `vboxnet0` (create it if it doesn't exist — see below)

> **Creating vboxnet0:** VirtualBox → File → Host Network Manager → Create. Leave defaults (192.168.56.1/24). Enable DHCP server.

### Shared Clipboard (optional but useful)
- General → Advanced → Shared Clipboard: **Bidirectional**

---

## 5. Install Ubuntu Server

Start the VM. It will boot from the ISO.

Work through the installer:

1. **Language**: English
2. **Keyboard**: your layout
3. **Installation type**: Ubuntu Server (not minimized)
4. **Network**: leave defaults — both adapters should show up. The NAT one (enp0s3) will get a DHCP address automatically.
5. **Storage**: use entire disk, no LVM required
6. **Profile setup**:
   - Your name: anything
   - Server name: `nomadai`
   - Username: your admin username (e.g. `admin`)
   - Password: something strong — this is your sudo account
7. **OpenSSH**: **Install OpenSSH server** — check this box. You'll use it to SSH in from your host.
8. **Featured snaps**: skip all, select nothing
9. Wait for install to complete → **Reboot**

When prompted, remove the ISO: Devices → Optical Drives → Remove disk. Press Enter.

---

## 6. First boot — find the VM's IP address

Log in with the username/password you set.

Find the host-only adapter IP (this is the IP your host will use to reach the observer):

```bash
ip addr show
```

Look for the interface that has a `192.168.56.x` address — that's the host-only adapter (usually `enp0s8`). Note this IP.

If it doesn't have an IP, bring it up:

```bash
sudo dhclient enp0s8
```

To make it persistent across reboots, edit the netplan config:

```bash
sudo nano /etc/netplan/00-installer-config.yaml
```

Add the second adapter so it reads up at boot:

```yaml
network:
  version: 2
  ethernets:
    enp0s3:
      dhcp4: true
    enp0s8:
      dhcp4: true
```

Apply:

```bash
sudo netplan apply
```

---

## 7. Copy NomadAI into the VM

From your **host machine**, copy the project into the VM over SSH. Replace `192.168.56.101` with your VM's actual IP:

```bash
scp -r /path/to/NomadAI admin@192.168.56.101:~/NomadAI
```

Or clone from git if the project is in a repo:

```bash
ssh admin@192.168.56.101
git clone <your-repo-url> ~/NomadAI
```

---

## 8. Run setup

SSH into the VM:

```bash
ssh admin@192.168.56.101
```

Run the setup script (this installs Bun, Ollama, pulls the model, creates the `nomadai` user, sets permissions, and registers the systemd service):

```bash
cd ~/NomadAI
sudo ./setup.sh
```

This will take a few minutes while the LLM model downloads. `llama3` is ~4.7 GB.

To use a different model:

```bash
sudo LLM_MODEL=mistral ./setup.sh
```

---

## 9. Start NomadAI

```bash
# Background (auto-managed by systemd)
sudo ./start.sh

# Foreground (see output directly in terminal, Ctrl+C to stop)
sudo ./start.sh --foreground
```

Check it's running:

```bash
sudo systemctl status nomadai
```

---

## 10. Access the observer

### Browser panel

By default the observer binds to `127.0.0.1` (localhost inside the VM). There are two ways to reach it from your host machine:

**Option A — SSH tunnel (recommended, no firewall changes needed):**

```bash
# On your host machine — replace admin@192.168.56.101 with your VM
ssh -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 -L 3002:127.0.0.1:3002 -N admin@192.168.56.101
```

Then open `http://localhost:3000` in your browser. The NC stream is at `nc localhost 3002`.

**Option B — Bind to host-only interface directly:**

Re-run setup with the VM's host-only IP:

```bash
sudo OBSERVER_BIND=192.168.56.101 OBSERVER_SUBNET=192.168.56.0/24 ./setup.sh
```

Then open `http://192.168.56.101:3000` in your browser.

Replace `192.168.56.101` with your VM's actual host-only IP (`ip addr show` inside the VM). The observer panel has three columns:

| Panel | What it shows |
|-------|--------------|
| **Thought Stream** | The AI's current thought and plan each loop |
| **Command Log** | Every tool call, result, and any blocked actions |
| **Memory / State** | Memory updates, module loads/unloads |

The panel auto-reconnects if the agent restarts.

### nc / netcat terminal stream

A plain-text TCP interface runs on port **3002**. Connect from your host:

```bash
nc 192.168.56.101 3002
```

You'll be prompted for credentials (set via `OBSERVER_USER` / `OBSERVER_PASS` env vars, default `nomad`/`nomad`):

```
Username: nomad
Password:

Welcome to NomadAI Observer
Type "help" for commands, "stream" to start live feed.

>
```

**Authentication** uses your OS user account — the same username and sudo password you use to log into the VM. `setup.sh` reads your shadow hash at install time and stores it in `/home/nomadai/.observer_auth` (readable only by the `nomadai` service user). Passwords are verified at runtime using `openssl passwd` — your password is never stored in plaintext anywhere.

**Rate limiting:** 5 failed attempts within 60 seconds triggers a 5-minute block for that IP. Each failure also adds a progressive delay (1s, 2s, 3s...) to slow brute-force attempts.

**Commands:**

| Command | Description |
|---------|-------------|
| `stream` | Start live event stream (all types) |
| `stream thought` | Stream only a specific event type |
| `stop` | Stop streaming, return to prompt |
| `status` | Show agent uptime and connection counts |
| `goals` | Show the AI's current goals |
| `memory <key>` | Read a long-term memory entry by key |
| `thoughts [n]` | Show last n lines from thoughts.log (default 20) |
| `history [n]` | Show last n tool calls from episodic log (default 10) |
| `quit` | Disconnect |

**Example session:**

```
$ nc 192.168.56.101 3002
Username: admin
Password:

Welcome to NomadAI Observer  [28/03/2026, 14:32:00]
Type "help" for commands, "stream" to start live feed.

> stream thought
[stream] Live stream started (filter: thought). Type "stop" to end.
[14:32:01] [thought        ] I should explore the filesystem to understand my environment
[14:32:08] [thought        ] The open/ directory has memory and modules subdirectories
[14:32:15] [thought        ] I'll write a small utility module to track my activity
stop
[stream] Stopped.
> goals
[goals] [normal] Explore the open/ filesystem
[goals] [high]   Build a self-monitoring module
> quit
Goodbye.
```

> **Note:** If your account uses SSH key-only login (no password in `/etc/shadow`), `setup.sh` will generate a random password and display it once during setup. Save it — it won't be shown again.

---

## 11. Testing without Ollama (mock mode)

You can run the full agent loop without Ollama to test the observer, tools, and permissions:

```bash
sudo LLM_MOCK=true ./start.sh --foreground
```

In mock mode the LLM bridge cycles through 10 canned actions (TimeNow, OSInfo, ReadDir, ThoughtLog, SetGoal, etc.) so every part of the system gets exercised. No model download needed.

## 12. Useful commands (from inside the VM)

```bash
# Stop the agent
sudo ./stop.sh

# Stop agent + ollama
sudo ./stop.sh --with-ollama

# Watch live logs
sudo tail -f ~/NomadAI/logs/agent.log

# systemd status
sudo systemctl status nomadai
sudo journalctl -u nomadai -f

# Check what the AI has written to open/
ls ~/NomadAI/open/
cat ~/NomadAI/open/thoughts.log
cat ~/NomadAI/open/goals.json

# Check snapshots
ls ~/NomadAI/open/snapshots/
```

---

## 13. VM management tips

**Save state instead of shutting down** (faster resume):

VirtualBox → Machine → Save State. The VM suspends instantly and resumes in seconds. NomadAI will continue from where it left off.

**Take a VirtualBox snapshot before making changes**:

VirtualBox → Machine → Take Snapshot. This is separate from NomadAI's own snapshots — it captures the entire VM disk state.

**Headless mode** (run VM without a window):

```bash
# On your host machine
VBoxManage startvm "NomadAI" --type headless
```

Then just SSH in as usual. Useful if you want the VM running in the background without a VirtualBox window open.

**Auto-start VM on host boot** (Linux hosts only):

```bash
sudo VBoxManage setproperty autostartdb /etc/vbox
sudo VBoxManage modifyvm "NomadAI" --autostart-enabled on
```

---

## 14. Resource recommendations by model

| Model | RAM for VM | CPU cores | Disk |
|-------|-----------|-----------|------|
| `llama3` (8B) | 6–8 GB | 4 | 40 GB |
| `mistral` (7B) | 6–8 GB | 4 | 40 GB |
| `llama3:70b` | 48 GB+ | 8+ | 80 GB |
| `phi3` (3.8B, lightweight) | 4 GB | 2 | 30 GB |

> If your host machine has a GPU, Ollama will use it automatically for significantly faster inference. VirtualBox does not pass through GPUs — for GPU acceleration, use a native Linux install or WSL2 instead.

---

## Troubleshooting

**Observer panel won't load**
- Check the VM's host-only IP is correct: `ip addr show`
- Check ports 3000/3001 are not blocked: `sudo ss -tlnp | grep -E '3000|3001'`
- Check the agent is running: `sudo systemctl status nomadai`

**Ollama not starting**
- Check logs: `sudo journalctl -u ollama -n 50`
- Try manually: `ollama serve` (run as the ollama user or root)

**Model too slow**
- Switch to a lighter model: `sudo LLM_MODEL=phi3 ./start.sh`
- Increase VM CPU cores in VirtualBox settings (requires VM to be powered off)

**SSH connection refused**
- Make sure OpenSSH was installed during Ubuntu setup: `sudo systemctl status ssh`
- If not installed: `sudo apt install openssh-server`

**`nomadai` user can't write to open/**
- Run setup again to fix permissions: `sudo ./setup.sh`
- Or manually: `sudo chown -R nomadai:nomadai ~/NomadAI/open`
