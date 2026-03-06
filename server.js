require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const crypto = require('crypto');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === '/stripe/webhook') {
      req.rawBody = buf;
    }
  }
}));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helper function for login tokens
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// Merchant auth middleware
function requireMerchant(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Missing token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'merchant') {
      return res.status(403).json({ success: false, message: 'Merchant access only' });
    }
    req.merchant = decoded; // { id, role }
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function generatePublicId() {
  // Short, readable voucher reference (customer shows this)
  return crypto.randomBytes(6).toString('hex').slice(0, 10).toUpperCase();
}

// Test DB connection route
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, serverTime: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Basic homepage
app.get('/', (req, res) => {
  res.send('Marketplace backend running');
});

// Admin login route
app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND role = $2',
      [email, 'admin']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const admin = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, admin.password);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    res.json({
      success: true,
      message: 'Admin logged in successfully',
      admin: { id: admin.id, name: admin.name, email: admin.email }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add a new deal (admin only)
app.post('/admin/add-deal', async (req, res) => {
  const { title, description, price, commission_percentage, merchant_id, image_url } = req.body;

  if (!title || !price || !merchant_id) {
    return res.status(400).json({ success: false, message: 'Title, price, and merchant_id are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO deals (title, description, price, commission_percentage, merchant_id, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, description || '', price, commission_percentage ?? 25, merchant_id, image_url || '']
    );

    res.json({ success: true, message: 'Deal added successfully', deal: result.rows[0] });
  } catch (err) {
    console.error('Add deal error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all deals (admin)
app.get('/admin/deals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, title, description, price, commission_percentage, merchant_id, image_url, active, created_at
      FROM deals
      ORDER BY created_at DESC
    `);

    res.json({ success: true, deals: result.rows });
  } catch (err) {
    console.error('Get deals error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin creates a merchant (NZBN + password)
app.post('/admin/create-merchant', async (req, res) => {
  const { name, nzbn, password } = req.body;

  if (!name || !nzbn || !password) {
    return res.status(400).json({ success: false, message: 'name, nzbn, password required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (name, nzbn, password, role)
       VALUES ($1, $2, $3, 'merchant')
       RETURNING id, name, nzbn, role`,
      [name, nzbn, hashedPassword]
    );

    res.json({ success: true, merchant: result.rows[0] });
  } catch (err) {
    console.error('Create merchant error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Merchant login (NZBN + password)
app.post('/merchant/login', async (req, res) => {
  const { nzbn, password } = req.body;

  if (!nzbn || !password) {
    return res.status(400).json({ success: false, message: 'nzbn and password required' });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, nzbn, password
       FROM users
       WHERE nzbn = $1 AND role = 'merchant'`,
      [nzbn]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid NZBN or password' });
    }

    const merchant = result.rows[0];
    const ok = await bcrypt.compare(password, merchant.password);

    if (!ok) {
      return res.status(401).json({ success: false, message: 'Invalid NZBN or password' });
    }

    const token = signToken({ id: merchant.id, role: 'merchant' });

    res.json({
      success: true,
      token,
      merchant: { id: merchant.id, name: merchant.name, nzbn: merchant.nzbn }
    });
  } catch (err) {
    console.error('Merchant login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ONE-TIME: add columns for rotating voucher codes (run once then remove)
app.get('/admin/migrate-vouchers-totp', async (req, res) => {
  try {
    await pool.query(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS public_id VARCHAR(20) UNIQUE;`);
    await pool.query(`ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS secret VARCHAR(255);`);
    res.send('✅ vouchers table updated (public_id, secret)');
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// TEMP: issue a voucher for testing (later this happens when customer pays)
app.post('/admin/issue-voucher', async (req, res) => {
  const { deal_id, order_id } = req.body;

  if (!deal_id || !order_id) {
    return res.status(400).json({ success: false, message: 'deal_id and order_id required' });
  }

  try {
    const public_id = generatePublicId();
    const secret = speakeasy.generateSecret({ length: 20 }).base32;

    const inserted = await pool.query(
  `INSERT INTO vouchers (code, order_id, deal_id, public_id, secret)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id, public_id`,
  [public_id, order_id, deal_id, public_id, secret]
);

    const code_right_now = speakeasy.totp({
      secret,
      encoding: 'base32',
      step: 120 // 2 minutes
    });

    res.json({
      success: true,
      voucher: {
        id: inserted.rows[0].id,
        public_id: inserted.rows[0].public_id,
        code_right_now
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Merchant redeems voucher (must belong to merchant's own deals)
app.post('/merchant/redeem', requireMerchant, async (req, res) => {
  const { public_id, code } = req.body;

  if (!public_id || !code) {
    return res.status(400).json({ success: false, message: 'public_id and code required' });
  }

  try {
    const found = await pool.query(
      `SELECT v.id AS voucher_id, v.redeemed, v.secret,
              d.id AS deal_id, d.merchant_id
       FROM vouchers v
       JOIN deals d ON d.id = v.deal_id
       WHERE v.public_id = $1`,
      [public_id]
    );

    if (found.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Voucher not found' });
    }

    const row = found.rows[0];

    // Only redeem vouchers for this merchant's own deals
    if (Number(row.merchant_id) !== Number(req.merchant.id)) {
      return res.status(403).json({ success: false, message: 'Not allowed to redeem other businesses vouchers' });
    }

    if (row.redeemed) {
      return res.status(400).json({ success: false, message: 'Voucher already redeemed' });
    }

    const ok = speakeasy.totp.verify({
      secret: row.secret,
      encoding: 'base32',
      token: String(code).trim(),
      step: 120,
      window: 1 // allow previous/next 2-min window
    });

    if (!ok) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }

    await pool.query(`UPDATE vouchers SET redeemed = TRUE, redeemed_at = NOW() WHERE id = $1`, [row.voucher_id]);

    res.json({ success: true, message: 'Voucher redeemed ✅' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Check JWT secret is attached (safe true/false only)
app.get('/check-jwt', (req, res) => {
  res.json({ hasJwtSecret: !!process.env.JWT_SECRET });
});

app.get('/check-stripe', (req, res) => {
  res.json({ hasStripeKey: !!process.env.STRIPE_SECRET_KEY });
});

// ONE-TIME: safer migration for voucher rotating codes (run once then remove)
app.get('/admin/migrate-vouchers-totp-v2', async (req, res) => {
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='vouchers' AND column_name='public_id'
        ) THEN
          ALTER TABLE vouchers ADD COLUMN public_id VARCHAR(20) UNIQUE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='vouchers' AND column_name='secret'
        ) THEN
          ALTER TABLE vouchers ADD COLUMN secret VARCHAR(255);
        END IF;
      END $$;
    `);

    res.send('✅ vouchers updated (v2): public_id + secret added');
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// TEMP: create a test order (so vouchers can reference a real order_id)
app.post('/admin/create-test-order', async (req, res) => {
  const { customer_id, deal_id, total_price } = req.body;
  if (!customer_id || !deal_id || !total_price) {
    return res.status(400).json({ success: false, message: 'customer_id, deal_id, total_price required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO orders (customer_id, deal_id, total_price)
       VALUES ($1, $2, $3)
       RETURNING id, customer_id, deal_id, total_price, created_at`,
      [customer_id, deal_id, total_price]
    );

    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// TEMP: create a test customer
app.post('/admin/create-test-customer', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'name and email required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO customers (name, email, oauth_provider)
       VALUES ($1, $2, 'test')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, email`,
      [name, email]
    );

    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create Stripe Checkout session (customer starts purchase)
app.post('/checkout/create-session', async (req, res) => {
  const { deal_id, customer_id } = req.body;

  if (!deal_id || !customer_id) {
    return res.status(400).json({ success: false, message: 'deal_id and customer_id required' });
  }

  try {
    const dealRes = await pool.query(
      `SELECT id, title, price, active
       FROM deals
       WHERE id = $1`,
      [deal_id]
    );

    if (dealRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    const deal = dealRes.rows[0];
    if (!deal.active) {
      return res.status(400).json({ success: false, message: 'Deal is not active' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'nzd',
            product_data: { name: deal.title },
            unit_amount: Math.round(Number(deal.price) * 100),
          },
          quantity: 1,
        },
      ],
      success_url: "http://localhost:3000/success",
      cancel_url: "http://localhost:3000",
      metadata: {
        deal_id: String(deal_id),
        customer_id: String(customer_id),
      },
    });

    res.json({ success: true, checkout_url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ success: false, message: 'Stripe session failed' });
  }
});

app.get('/checkout/success', (req, res) => res.send('✅ Payment success'));
app.get('/checkout/cancel', (req, res) => res.send('❌ Payment cancelled'));

app.post('/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const deal_id = Number(session.metadata.deal_id);
    const customer_id = Number(session.metadata.customer_id);

    const dealRes = await pool.query(
      `SELECT id, price FROM deals WHERE id = $1`,
      [deal_id]
    );

    const deal = dealRes.rows[0];

    const orderRes = await pool.query(
      `INSERT INTO orders (customer_id, deal_id, total_price, stripe_session_id, payment_status)
       VALUES ($1, $2, $3, $4, 'paid')
       RETURNING id`,
      [customer_id, deal_id, deal.price, session.id]
    );

    const order_id = orderRes.rows[0].id;

    const public_id = generatePublicId();
    const secret = speakeasy.generateSecret({ length: 20 }).base32;

    await pool.query(
      `INSERT INTO vouchers (code, order_id, deal_id, public_id, secret)
       VALUES ($1, $2, $3, $4, $5)`,
      [public_id, order_id, deal_id, public_id, secret]
    );

    console.log('Voucher created from Stripe payment');
  }

  res.json({ received: true });
});

app.get('/voucher/:public_id/code', async (req, res) => {
  const { public_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, public_id, secret, redeemed
       FROM vouchers
       WHERE public_id = $1`,
      [public_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Voucher not found' });
    }

    const voucher = result.rows[0];

    if (voucher.redeemed) {
      return res.status(400).json({ success: false, message: 'Voucher already redeemed' });
    }

    const code = speakeasy.totp({
      secret: voucher.secret,
      encoding: 'base32',
      step: 120
    });

    res.json({
      success: true,
      public_id: voucher.public_id,
      code
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/customer/vouchers', async (req, res) => {
  const customer_id = Number(req.query.customer_id);

  if (!customer_id) {
    return res.status(400).json({ success: false, message: 'customer_id required' });
  }

  try {
    const result = await pool.query(
      `SELECT
         v.id,
         v.public_id,
         v.redeemed,
         v.redeemed_at,
         v.created_at,
         d.title,
         d.description,
         d.price,
         d.image_url
       FROM vouchers v
       JOIN orders o ON o.id = v.order_id
       JOIN deals d ON d.id = v.deal_id
       WHERE o.customer_id = $1
       ORDER BY v.created_at DESC`,
      [customer_id]
    );

    res.json({ success: true, vouchers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Public: list all active deals
app.get('/deals', async (req, res) => {
  try {
const result = await pool.query(
  `SELECT
    d.id,
    d.title,
    d.description,
    d.price,
    d.image_url,
    d.merchant_id,
    d.category_id,
    c.name AS category_name,
    d.created_at
   FROM deals d
   LEFT JOIN categories c ON c.id = d.category_id
   WHERE d.active = TRUE
   ORDER BY d.created_at DESC`
);

    res.json({
      success: true,
      deals: result.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Public: get a single deal
app.get('/deals/:id', async (req, res) => {
  const deal_id = Number(req.params.id);

  try {
const result = await pool.query(
  `SELECT
    d.id,
    d.title,
    d.description,
    d.price,
    d.image_url,
    d.merchant_id,
    d.category_id,
    c.name AS category_name,
    d.created_at
   FROM deals d
   LEFT JOIN categories c ON c.id = d.category_id
   WHERE d.id = $1 AND d.active = TRUE`,
  [deal_id]
);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    res.json({
      success: true,
      deal: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/merchant/redemptions', requireMerchant, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         v.id,
         v.public_id,
         v.redeemed,
         v.redeemed_at,
         d.title,
         d.price,
         o.customer_id
       FROM vouchers v
       JOIN deals d ON d.id = v.deal_id
       JOIN orders o ON o.id = v.order_id
       WHERE d.merchant_id = $1
         AND v.redeemed = TRUE
       ORDER BY v.redeemed_at DESC`,
      [req.merchant.id]
    );

    res.json({ success: true, redemptions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Public: list all categories
app.get('/categories', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name
       FROM categories
       ORDER BY name`
    );

    res.json({
      success: true,
      categories: result.rows
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Listen on port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));