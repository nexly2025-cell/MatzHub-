# MatzHub Production Deployment & Verification Checklist

## 🎯 Deployment Status

**vercel.json** ✅ Created  
**Database** ✅ Functional (35 published products)  
**APIs** ✅ Core endpoints working  
**Ingestion** ✅ WhatsApp webhook tested and operational  

---

## 📋 Pre-Deployment: Required Credentials

Before deploying to **matzhub.com**, gather these credentials:

### Production Database
```
DATABASE_URL=postgresql://USER:PASSWORD@host.region.rds.amazonaws.com:5432/matzhub
```
Options:
- AWS RDS (recommended)
- Railway.app (easy integration)
- Neon (free tier available)
- DigitalOcean Managed Database

### Admin & Security
```
ADMIN_PASSWORD=<strong-random-password>  # min 12 chars, mixed case + numbers
ADMIN_SESSION_SECRET=<64-hex-chars>      # openssl rand -hex 32
INGEST_TOKEN=<32-hex-chars>              # for WhatsApp webhook auth
CRON_SECRET=<32-hex-chars>               # for scheduled jobs auth
```

### WhatsApp Configuration
Choose ONE path:

**Option A: Official Cloud API**
```
WHATSAPP_TOKEN=EAAB_...                  # Business account token from Meta
WHATSAPP_PHONE_ID=123456789012345        # Phone number ID
```

**Option B: Baileys Worker (recommended for 24/7)**
```
WA_WORKER_URL=https://worker-domain.com  # Your worker server
WA_WORKER_TOKEN=<bearer-token>
```

### Image Storage
```
SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ_...        # Service role key (not anon key)
SUPABASE_BUCKET=products
```

### Optional Integrations
```
OPENAI_API_KEY=sk-...                    # For product enrichment
TELEGRAM_BOT_TOKEN=123456:ABC...         # For alerts
TELEGRAM_CHAT_ID=-1001234567890          # Admin alerts channel
```

---

## 🚀 Deployment to Vercel

### Step 1: Push Code
```bash
git add -A
git commit -m "Production deployment: vercel.json + search query fix"
git push origin main
```

### Step 2: Set Environment Variables in Vercel Dashboard
1. Go to **Settings → Environment Variables**
2. Add each variable from above with scope: **Production**
3. Use the `@` prefix in vercel.json (e.g., `@database_url` = `DATABASE_URL` in dashboard)

### Step 3: Trigger Deployment
```bash
vercel deploy --prod
# or use Vercel dashboard
```

### Step 4: Verify Live
```bash
curl https://matzhub.com/api/health
curl https://matzhub.com/api/readiness
```

---

## ✅ Component Verification (Local → Production)

### Homepage & Browsing
- [ ] Homepage loads: `http://localhost:3000/` → `https://matzhub.com/`
- [ ] Categories display (6 total)
- [ ] Products display (35 published)
- [ ] Product cards show image, title, price

### Product Details
- [ ] Click product → `/p/[slug]` page loads
- [ ] Product images load from Pexels
- [ ] Price, MRP, rating display
- [ ] Add to cart button works

### Search Functionality
```bash
# Local test
curl "http://localhost:3000/api/search?q=watch" | jq '.items | length'
# Production test
curl "https://matzhub.com/api/search?q=watch" | jq '.items | length'
```
- [ ] Search returns results
- [ ] Filters work (category, price, brand, color)
- [ ] Sorting works (new, price_asc, price_desc, discount)

### Admin Panel
- [ ] `/admin/login` page loads
- [ ] Enter ADMIN_PASSWORD (set in env)
- [ ] Dashboard accessible
- [ ] View orders, products, settings

### Shopping Cart & Checkout
- [ ] Add to cart → Cart persists (localStorage)
- [ ] View cart: `/cart`
- [ ] Checkout flow: `/checkout`
- [ ] Payment (if Razorpay configured)

### Orders & Tracking
- [ ] Create order (admin or via API)
- [ ] Track order: `/track` page
- [ ] Order status updates

### API Endpoints
```bash
# Health checks
curl https://matzhub.com/api/health
curl https://matzhub.com/api/readiness

# Search
curl "https://matzhub.com/api/search?q=sunglasses"

# Categories
curl https://matzhub.com/api/products/categories

# Coupons validation
curl -X POST https://matzhub.com/api/coupons/validate \
  -H "Content-Type: application/json" \
  -d '{"code":"NEW10"}'

# Orders (requires auth)
curl https://matzhub.com/api/orders

# Reviews
curl "https://matzhub.com/api/reviews?productId=1"
```

### WhatsApp Product Ingestion
```bash
# Test ingestion endpoint
curl -X POST https://matzhub.com/api/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -d '{
    "messages": [{
      "messageId": "test-'$(date +%s)'",
      "groupId": "919876543210-1234567890@g.us",
      "caption": "Premium Sunglasses UV Protected Black Frame",
      "imageUrl": "https://images.pexels.com/photos/18533668/pexels-photo-18533668.jpeg",
      "source": "whatsapp"
    }]
  }'
```
- [ ] Returns `{"ok": true, "processed": 1}`
- [ ] Check DB: `SELECT * FROM ingestion_events ORDER BY created_at DESC LIMIT 1;`

---

## 🤖 WhatsApp Worker Deployment

### For 24/7 Product Ingestion (Separate from Vercel)

**Deploy to:** AWS EC2 / DigitalOcean / Railway / Render

#### 1. Configure Worker Environment
```bash
cd /workspaces/MatzHub-/worker
cp /path/to/.env.production .env

# Key variables:
cat .env
MATZHUB_API_URL=https://matzhub.com
INGEST_TOKEN=<from production env>
WA_GROUPS=919876543210-1234567890@g.us:suppliers_watch,919876543211-1234567891@g.us:suppliers_bags
SUPABASE_URL=<from production env>
SUPABASE_SERVICE_ROLE_KEY=<from production env>
```

#### 2. Start Worker
```bash
# First time: QR code linking
npm install
npm start
# Scan QR code in terminal or open: .wa-session/whatsapp-qr.png

# OR use pairing code (if QR fails)
WA_PAIRING_NUMBER=919876543210 npm start
# Follow 8-digit code to WhatsApp → Linked Devices
```

#### 3. Verify Connection
```bash
# Check logs
tail -f logs/worker.log

# Send test from manufacturer group
# Message should appear in: https://matzhub.com/api/ingest logs
# Product should appear in DB with stage: "needs_review" or "published"
```

---

## 📊 Database Migrations & Seed

### For Production Database
```bash
# Create DB connection
export DATABASE_URL="postgresql://USER:PASS@host:5432/matzhub"

# Apply migrations
npx drizzle-kit push

# Seed initial data
npm run seed
```

---

## 🔐 Security Checklist

- [ ] `ADMIN_PASSWORD` is strong (12+ chars, mixed case, numbers, symbols)
- [ ] `ADMIN_SESSION_SECRET` generated with `openssl rand -hex 32`
- [ ] `INGEST_TOKEN` generated with `openssl rand -hex 32`
- [ ] `CRON_SECRET` generated with `openssl rand -hex 32`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` used (NOT anon key)
- [ ] `.env.production` file **NOT** committed to git
- [ ] Environment variables set in Vercel dashboard (not in code)
- [ ] API endpoints protected with auth headers
- [ ] Database URL uses proper SSL connection

---

## 📱 Customer Communication

Update your WhatsApp account:
```env
NEXT_PUBLIC_CUSTOMER_WHATSAPP=91XXXXXXXXXX  # Your customer support number
NEXT_PUBLIC_SITE_URL=https://matzhub.com
```

This is used for:
- Contact page
- Order confirmation messages
- Support links

---

## 🔄 Cron Jobs (Vercel)

Already configured in `vercel.json`. These run automatically:
- Every 2 hours: `/api/cron/notify` (send pending notifications)
- Every 10 minutes: `/api/cron/self-heal` (fix inconsistencies)
- Every 15 minutes: `/api/cron/watchdog` (health monitoring)
- Daily: `/api/cron/supplier`, `/api/cron/digest`

Verify with:
```bash
curl "https://matzhub.com/api/cron/notify?secret=$CRON_SECRET"
# Should return: {"ok": true, "sent": N}
```

---

## 📞 Next Steps

1. **Gather credentials** (database, Supabase, optional APIs)
2. **Deploy to Vercel** (push code, set env vars, trigger deployment)
3. **Test production** (run verification checklist above)
4. **Deploy worker** (for 24/7 WhatsApp ingestion if using Baileys)
5. **Monitor** (check logs, set up alerts)

---

## 🆘 Troubleshooting

### "Database connection refused"
- Verify DATABASE_URL in Vercel dashboard
- Check firewall rules (allow Vercel IP ranges)
- Test local connection: `psql $DATABASE_URL -c "SELECT 1"`

### "Ingestion endpoint returns 401"
- Verify `INGEST_TOKEN` matches in Vercel and worker env
- Check `Authorization: Bearer $INGEST_TOKEN` header

### "Images not loading"
- Verify Pexels CDN works: `curl https://images.pexels.com/...`
- Check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` if using custom uploads

### "Worker can't connect to API"
- Verify `MATZHUB_API_URL=https://matzhub.com`
- Check firewall allows outbound HTTPS
- Verify API health: `curl https://matzhub.com/api/health`

---

**Status:** Ready for production ✅  
**Files Modified:** vercel.json, src/lib/queries.ts  
**Build Command:** `npm run build` ✅  
**Tests:** All passing ✅
