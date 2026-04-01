#!/bin/bash
# Run this ONCE on your Synology NAS via SSH
# This allows passwordless docker commands for the popdam user

echo "Adding passwordless sudo for docker commands..."
echo "popdam ALL=(ALL) NOPASSWD: /usr/local/bin/docker, /usr/local/bin/docker-compose" | sudo tee /etc/sudoers.d/docker-popdam

echo ""
echo "Done! Now you can run docker commands without password."
echo ""
echo "To update the synology-monitor-agent to the latest version:"
echo "  cd /volume1/docker/synology-monitor-agent"
echo "  sudo /usr/local/bin/docker-compose pull"
echo "  sudo /usr/local/bin/docker-compose up -d"
