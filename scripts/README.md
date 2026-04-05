# Scripts

## Database (usme-db)

### Quick start

```bash
./scripts/start-db.sh   # start or create the container
./scripts/stop-db.sh    # stop the container
```

### Auto-restart on boot

The container is created with `--restart unless-stopped`, so once started once, Docker daemon will automatically restart it on system boot. No additional setup needed for server environments.

### Optional: systemd user service

For user-session auto-start (e.g. on login), install the systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cp scripts/usme-db.service ~/.config/systemd/user/
systemctl --user enable usme-db
systemctl --user start usme-db
```

This is optional — the Docker restart policy handles most cases. The systemd service is useful if you want the container managed through `systemctl --user` commands or need it tied to your login session.
