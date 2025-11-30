
# EC2 Deployment Guide for Crypto Analyst UI (Ubuntu)

This guide walks you through setting up a **new Ubuntu EC2 instance** to host your Next.js + PM2 + NGINX app.

---

## 1. Launch an EC2 Ubuntu Server

Choose:

- Ubuntu 22.04 LTS  
- t2.micro or t3.micro  
- Open inbound ports: 80, 443, 22  

SSH into your server:

```bash
ssh -i key.pem ubuntu@YOUR_EC2_IP
```

---

## 2. Update Server & Install Basics

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install git curl -y
```

---

## 3. Install Node.js (LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

---

## 4. Install PM2

```bash
sudo npm install -g pm2
pm2 install pm2-logrotate
```

---

## 5. Clone Your GitHub Repository

Public:

```bash
git clone https://github.com/Mmarucr7/crypto-analyst-ui.git
```

Private using PAT:

```bash
git clone https://YOUR_GITHUB_USERNAME:YOUR_PAT@github.com/Mmarucr7/crypto-analyst-ui.git
```

Enter directory:

```bash
cd crypto-analyst-ui
```

---

## 6. Create `.env.local`

```bash
nano .env.local
```

Paste your environment variables.

Save using CTRL+X → Y → ENTER.

---

## 7. Install Dependencies

```bash
npm install
```

---

## 8. Build the App

```bash
npm run build
```

---

## 9. Run App on PM2

```bash
pm2 start npm --name "crypto-ui" -- start
pm2 logs crypto-ui
pm2 startup
pm2 save
```

Your app runs on:

```
http://YOUR_EC2_IP:3000
```

---

## 10. Install NGINX

```bash
sudo apt install nginx -y
```

---

## 11. Configure Reverse Proxy (80 → 3000)

```bash
sudo nano /etc/nginx/sites-available/default
```

Replace contents with:

```
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Save, test, and reload:

```bash
sudo nginx -t
sudo systemctl restart nginx
```

---

## 12. Access Your App

Your app is now accessible at:

```
http://YOUR_EC2_IP
```

---

## 13. Updating Code

```bash
git pull
npm install
npm run build
pm2 restart crypto-ui
```

---

## 14. Optional GitHub Actions Deployment

You can automate deployments through GitHub Actions if desired.

---

## DONE 🎉

Your EC2 server with Node.js, PM2, NGINX, and your Next.js app is fully operational.
