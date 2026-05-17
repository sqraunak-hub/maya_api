# Docker Deployment Guide - Fitness Voice Assistant API

## Prerequisites

Before deploying, ensure you have:

- Docker installed on your hosting server
- Docker Compose (optional, but recommended)
- Your API keys: `GROQ_API_KEY`
- `google-credentials.json` file (Google Cloud credentials)

## Local Testing (Before Deploying)

### 1. Build the Docker Image Locally

```bash
cd fitness-voice-backend
docker build -t fitness-voice-api:latest .
```

### 2. Run with Docker Compose (Easiest)

Create a `.env` file in the `fitness-voice-backend` directory:

```bash
# .env
GROQ_API_KEY=your_groq_api_key_here
```

Then run:

```bash
docker-compose up -d
```

The API will be available at `http://localhost:3000`

### 3. Or Run with Docker Command

```bash
docker run -d \
  --name fitness-voice-api \
  -p 3000:3000 \
  -e GROQ_API_KEY=your_groq_api_key_here \
  -e NODE_ENV=production \
  -v $(pwd)/uploads:/app/uploads \
  fitness-voice-api:latest
```

## Production Deployment Steps

### Option 1: Deploy to VPS (DigitalOcean, Linode, AWS EC2, etc.)

#### Step 1: Connect to Your Server

```bash
ssh root@your_server_ip
```

#### Step 2: Install Docker & Docker Compose

```bash
# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Verify installation
docker --version
docker-compose --version
```

#### Step 3: Create App Directory

```bash
mkdir -p /app/fitness-voice-api
cd /app/fitness-voice-api
```

#### Step 4: Upload Your Files

Transfer your Docker files to the server:

```bash
# From your local machine
scp Dockerfile root@your_server_ip:/app/fitness-voice-api/
scp docker-compose.yml root@your_server_ip:/app/fitness-voice-api/
scp server.js root@your_server_ip:/app/fitness-voice-api/
scp package.json root@your_server_ip:/app/fitness-voice-api/
scp package-lock.json root@your_server_ip:/app/fitness-voice-api/
scp google-credentials.json root@your_server_ip:/app/fitness-voice-api/
```

Or clone from Git if you have a repository:

```bash
cd /app/fitness-voice-api
git clone your_repo_url .
```

#### Step 5: Create Environment File

On the server:

```bash
cd /app/fitness-voice-api
cat > .env << EOF
GROQ_API_KEY=your_groq_api_key_here
NODE_ENV=production
PORT=3000
EOF
```

#### Step 6: Build & Run

```bash
docker-compose build
docker-compose up -d
```

#### Step 7: Verify It's Running

```bash
# Check container status
docker ps

# Check logs
docker logs -f fitness-voice-api

# Test the health endpoint
curl http://localhost:3000
```

### Option 2: Deploy to Docker Hub + Server

#### Step 1: Create Docker Hub Account

Visit [hub.docker.com](https://hub.docker.com) and create an account.

#### Step 2: Build & Push Image

From your local machine:

```bash
# Login to Docker Hub
docker login

# Build with your username tag
docker build -t yourusername/fitness-voice-api:latest .

# Push to Docker Hub
docker push yourusername/fitness-voice-api:latest
```

#### Step 3: Deploy on Server

```bash
# On your server
docker login
docker pull yourusername/fitness-voice-api:latest

# Create docker-compose.yml using the image
cat > docker-compose.yml << 'EOF'
version: '3.8'
services:
  fitness-voice-api:
    image: yourusername/fitness-voice-api:latest
    container_name: fitness-voice-api
    ports:
      - "3000:3000"
    environment:
      GROQ_API_KEY: ${GROQ_API_KEY}
      NODE_ENV: production
    volumes:
      - ./uploads:/app/uploads
      - ./google-credentials.json:/app/google-credentials.json:ro
    restart: unless-stopped
EOF

# Create .env with your keys
echo "GROQ_API_KEY=your_key_here" > .env

# Start
docker-compose up -d
```

### Option 3: Deploy to Heroku

**Note:** Heroku has limited free tier. Consider paid alternatives.

#### Step 1: Install Heroku CLI

```bash
curl https://cli.heroku.com/install.sh | sh
heroku login
```

#### Step 2: Create Heroku App

```bash
heroku create your-app-name
```

#### Step 3: Set Environment Variables

```bash
heroku config:set GROQ_API_KEY=your_groq_api_key_here -a your-app-name
```

#### Step 4: Deploy

```bash
# Add Heroku remote
heroku git:remote -a your-app-name

# Deploy
git push heroku main  # or your branch name
```

### Option 4: Deploy to AWS ECS (Container Service)

1. Push your image to Amazon ECR
2. Create an ECS cluster
3. Create a task definition
4. Run the task with proper security groups and environment variables

Detailed guide: [AWS ECS Docker Deployment](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/docker-basics.html)

## Managing the Container

### View Logs

```bash
docker logs fitness-voice-api
docker logs -f fitness-voice-api  # Follow logs in real-time
```

### Restart Container

```bash
docker restart fitness-voice-api
```

### Stop Container

```bash
docker stop fitness-voice-api
```

### Update & Redeploy

```bash
# Pull latest code
cd /app/fitness-voice-api
git pull origin main

# Rebuild and restart
docker-compose down
docker-compose up -d --build
```

### Monitor Resource Usage

```bash
docker stats fitness-voice-api
```

## Networking & Reverse Proxy Setup

### Use Nginx as Reverse Proxy

```bash
# Install Nginx
apt install -y nginx

# Create Nginx config
cat > /etc/nginx/sites-available/fitness-api << 'EOF'
upstream fitness_api {
    server localhost:3000;
}

server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://fitness_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

# Enable site
ln -s /etc/nginx/sites-available/fitness-api /etc/nginx/sites-enabled/

# Test & restart
nginx -t
systemctl restart nginx
```

### Setup SSL with Let's Encrypt

```bash
apt install -y certbot python3-certbot-nginx

certbot --nginx -d your-domain.com
```

## Security Checklist

- [ ] Change default passwords
- [ ] Set up firewall (only open necessary ports)
- [ ] Use HTTPS/SSL certificate
- [ ] Keep API keys in `.env` file (never commit to git)
- [ ] Set `NODE_ENV=production`
- [ ] Use strong GROQ API key
- [ ] Implement rate limiting
- [ ] Regular backups of `uploads` directory

## Troubleshooting

### Container Won't Start

```bash
docker logs fitness-voice-api
docker inspect fitness-voice-api
```

### Permission Issues

```bash
# Fix file permissions
chmod 755 /app/fitness-voice-api/uploads
chown -R 1000:1000 /app/fitness-voice-api
```

### Google Credentials Error

```bash
# Ensure credentials file exists and is readable
ls -la google-credentials.json

# If missing, upload it again
scp google-credentials.json root@your_server_ip:/app/fitness-voice-api/
```

### Port Already in Use

```bash
# Check what's using port 3000
lsof -i :3000

# Kill process or change Docker port mapping
```

## Monitoring & Auto-Restart

Docker Compose's `restart: unless-stopped` policy keeps your container running.

For advanced monitoring, install:

```bash
# Install Portainer for Docker management UI
docker run -d -p 9000:9000 \
  --name portainer \
  --restart always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  portainer/portainer-ce:latest
```

Access at: `http://your_server_ip:9000`

---

## Testing the Deployed API

```bash
# Health check
curl http://your-domain.com

# Expected response
# {"status":"online","message":"Fitness Voice Agent API","timestamp":"2024-01-15T..."}
```

---

You're ready to deploy! 🚀
