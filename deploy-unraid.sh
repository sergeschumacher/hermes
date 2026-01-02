#!/bin/bash
#
# Hermes Unraid Deployment Script
# Builds Docker image locally, transfers to Unraid, and runs with Intel QSV GPU support
#
set -e

# =============================================================================
# CONFIGURATION - EDIT THESE VALUES
# =============================================================================
UNRAID_HOST="192.168.178.201"     # Your Unraid IP address
UNRAID_USER="root"                # Unraid SSH user (usually root)
UNRAID_PASS=""                    # Unraid SSH password (leave empty to prompt)
CONTAINER_NAME="hermes"           # Container name on Unraid
IMAGE_NAME="hermes:latest"        # Docker image name
HOST_PATH="/mnt/disks/Movies"     # Host path on Unraid
DATA_PATH="/hermesdata/data"      # DATA_PATH inside container
PORT="4000"                       # Host port to expose

# =============================================================================
# SCRIPT START
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       Hermes Unraid Deployment             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""

# Check if IP is configured (placeholder is 192.168.1.XXX)
if [[ "$UNRAID_HOST" == "192.168.1.XXX" ]]; then
    echo -e "${RED}ERROR: Please edit this script and set UNRAID_HOST to your Unraid IP address${NC}"
    exit 1
fi

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo -e "${RED}ERROR: Docker is not installed or not in PATH${NC}"
    exit 1
fi

# Check if sshpass is available
if ! command -v sshpass &> /dev/null; then
    echo -e "${RED}ERROR: sshpass is not installed${NC}"
    echo "Install with: brew install hudochenkov/sshpass/sshpass"
    exit 1
fi

# Prompt for password if not set
if [[ -z "$UNRAID_PASS" ]]; then
    echo -e "${YELLOW}Enter password for ${UNRAID_USER}@${UNRAID_HOST}:${NC}"
    read -s UNRAID_PASS
    echo ""
fi

# SSH/SCP wrapper functions
do_ssh() {
    sshpass -p "$UNRAID_PASS" ssh -o StrictHostKeyChecking=no ${UNRAID_USER}@${UNRAID_HOST} "$@"
}

do_scp() {
    sshpass -p "$UNRAID_PASS" scp -o StrictHostKeyChecking=no "$@"
}

# Check SSH connectivity
echo -e "${YELLOW}Checking SSH connection to Unraid...${NC}"
if ! do_ssh "echo 'SSH OK'" 2>/dev/null; then
    echo -e "${RED}ERROR: Cannot connect to ${UNRAID_HOST} via SSH${NC}"
    echo "Please ensure:"
    echo "  1. SSH is enabled on Unraid (Settings → Management Access → SSH)"
    echo "  2. The password is correct"
    exit 1
fi
echo -e "${GREEN}✓ SSH connection OK${NC}"

# Step 1: Build image for linux/amd64
echo ""
echo -e "${YELLOW}[1/6] Building Docker image for linux/amd64...${NC}"
docker buildx build --platform linux/amd64 -f Dockerfile.unraid -t $IMAGE_NAME --load .
echo -e "${GREEN}✓ Image built${NC}"

# Step 2: Save image to tar
echo ""
echo -e "${YELLOW}[2/6] Saving image to tar archive...${NC}"
docker save $IMAGE_NAME -o hermes-image.tar
TAR_SIZE=$(du -h hermes-image.tar | cut -f1)
echo -e "${GREEN}✓ Image saved (${TAR_SIZE})${NC}"

# Step 3: Copy to Unraid
echo ""
echo -e "${YELLOW}[3/6] Copying image to Unraid (this may take a few minutes)...${NC}"
do_scp hermes-image.tar ${UNRAID_USER}@${UNRAID_HOST}:/tmp/
echo -e "${GREEN}✓ Image transferred${NC}"

# Step 4: Load image on Unraid
echo ""
echo -e "${YELLOW}[4/6] Loading image on Unraid...${NC}"
do_ssh "docker load -i /tmp/hermes-image.tar && rm /tmp/hermes-image.tar"
echo -e "${GREEN}✓ Image loaded${NC}"

# Step 5: Stop/remove existing container
echo ""
echo -e "${YELLOW}[5/6] Stopping existing container (if any)...${NC}"
do_ssh "docker stop $CONTAINER_NAME 2>/dev/null || true; docker rm $CONTAINER_NAME 2>/dev/null || true"
echo -e "${GREEN}✓ Old container removed${NC}"

# Step 6: Create data directory and start container
echo ""
echo -e "${YELLOW}[6/6] Starting container with Intel QSV GPU...${NC}"
do_ssh "mkdir -p ${HOST_PATH}/data && docker run -d \
    --name $CONTAINER_NAME \
    --restart unless-stopped \
    --device=/dev/dri:/dev/dri \
    -p ${PORT}:3000 \
    -p 5004:5004 \
    -p 65001:65001/udp \
    -v ${HOST_PATH}:/hermesdata \
    -e DATA_PATH=${DATA_PATH} \
    $IMAGE_NAME"
echo -e "${GREEN}✓ Container started${NC}"

# Cleanup local tar
rm -f hermes-image.tar

# Verify container is running
echo ""
echo -e "${YELLOW}Verifying deployment...${NC}"
sleep 2
CONTAINER_STATUS=$(do_ssh "docker inspect -f '{{.State.Status}}' $CONTAINER_NAME 2>/dev/null || echo 'not found'")

if [[ "$CONTAINER_STATUS" == "running" ]]; then
    echo -e "${GREEN}✓ Container is running${NC}"
else
    echo -e "${RED}WARNING: Container status: $CONTAINER_STATUS${NC}"
    echo "Check logs with: ssh ${UNRAID_USER}@${UNRAID_HOST} 'docker logs $CONTAINER_NAME'"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Deployment Complete!               ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Hermes is now running at: ${GREEN}http://${UNRAID_HOST}:${PORT}${NC}"
echo ""
echo "First-time setup:"
echo "  1. Open http://${UNRAID_HOST}:${PORT}/settings"
echo "  2. Configure your IPTV sources"
echo "  3. Set Hardware Acceleration to 'vaapi' for Intel QSV"
echo ""
echo "Useful commands:"
echo "  View logs:     ssh ${UNRAID_USER}@${UNRAID_HOST} 'docker logs -f $CONTAINER_NAME'"
echo "  Stop:          ssh ${UNRAID_USER}@${UNRAID_HOST} 'docker stop $CONTAINER_NAME'"
echo "  Start:         ssh ${UNRAID_USER}@${UNRAID_HOST} 'docker start $CONTAINER_NAME'"
echo "  Restart:       ssh ${UNRAID_USER}@${UNRAID_HOST} 'docker restart $CONTAINER_NAME'"
echo ""
