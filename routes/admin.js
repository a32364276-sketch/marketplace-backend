const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authenticateAdmin = require('../middleware/authenticateAdmin');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const router = express.Router();

router.post('/login', async (req, res) => {
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

    const token = jwt.sign(
      {
        id: admin.id,
        role: 'admin',
        email: admin.email
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Admin logged in successfully',
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const categoriesCount = await pool.query('SELECT COUNT(*) FROM categories');
    const merchantsCount = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'merchant'");
    const dealsCount = await pool.query('SELECT COUNT(*) FROM deals');
    const ordersCount = await pool.query('SELECT COUNT(*) FROM orders');

    res.json({
      success: true,
      stats: {
        categories: Number(categoriesCount.rows[0].count),
        merchants: Number(merchantsCount.rows[0].count),
        deals: Number(dealsCount.rows[0].count),
        orders: Number(ordersCount.rows[0].count),
      }
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/categories', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY created_at DESC');
    res.json({ success: true, categories: result.rows });
  } catch (err) {
    console.error('Get categories error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/categories', authenticateAdmin, async (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Category name required' });
  }

  try {
    const existing = await pool.query(
      'SELECT id FROM categories WHERE LOWER(name) = LOWER($1)',
      [name.trim()]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Category already exists' });
    }

    const result = await pool.query(
      'INSERT INTO categories (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );

    res.json({ success: true, category: result.rows[0] });
  } catch (err) {
    console.error('Create category error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/merchants', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, nzbn, role, created_at
       FROM users
       WHERE role = 'merchant'
       ORDER BY created_at DESC`
    );

    res.json({ success: true, merchants: result.rows });
  } catch (err) {
    console.error('Get merchants error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/create-merchant', authenticateAdmin, async (req, res) => {
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

router.patch('/deals/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE deals
       SET active = NOT active
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Deal not found' });
    }

    res.json({ success: true, deal: result.rows[0] });
  } catch (err) {
    console.error('Toggle deal error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/orders', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.total_price,
        o.payment_status,
        o.created_at,
        c.name AS customer_name,
        c.email AS customer_email,
        d.title AS deal_title,
        v.public_id AS voucher_id
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN deals d ON o.deal_id = d.id
      LEFT JOIN vouchers v ON v.order_id = o.id
      ORDER BY o.created_at DESC
    `);

    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/payouts', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id AS merchant_id,
        u.name AS merchant_name,
        u.nzbn,

        COUNT(o.id) AS total_orders,
        COALESCE(SUM(o.total_price), 0) AS gross_sales,

        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM vouchers v
              WHERE v.order_id = o.id
              AND v.redeemed = true
            )
            THEN 1
            ELSE 0
          END
        ), 0) AS redeemed_orders,

        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM vouchers v
              WHERE v.order_id = o.id
              AND v.redeemed = true
            )
            THEN o.total_price
            ELSE 0
          END
        ), 0) AS redeemed_sales,

        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM vouchers v
              WHERE v.order_id = o.id
              AND v.redeemed = true
            )
            THEN o.total_price * (d.commission_percentage / 100.0)
            ELSE 0
          END
        ), 0) AS redeemed_platform_commission,

        COALESCE(SUM(
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM vouchers v
              WHERE v.order_id = o.id
              AND v.redeemed = true
            )
            THEN o.total_price * (1 - d.commission_percentage / 100.0)
            ELSE 0
          END
        ), 0) AS merchant_payout_due

      FROM orders o
      JOIN deals d ON o.deal_id = d.id
      JOIN users u ON d.merchant_id = u.id
      WHERE o.payment_status = 'paid'
      GROUP BY u.id, u.name, u.nzbn
      ORDER BY merchant_payout_due DESC
    `);

    res.json({
      success: true,
      payouts: result.rows
    });
  } catch (err) {
    console.error('Get payouts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET PAYOUTS DUE FOR CURRENT PERIOD (20th cycle)
router.get('/payouts/due', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id AS merchant_id,
        u.name AS merchant_name,
        u.nzbn,

        COUNT(v.id) AS redeemed_count,

        COALESCE(SUM(o.total_price), 0) AS redeemed_sales,

        COALESCE(SUM(o.total_price * (d.commission_percentage / 100.0)), 0) AS platform_commission,

        COALESCE(SUM(o.total_price * (1 - d.commission_percentage / 100.0)), 0) AS merchant_amount

      FROM vouchers v
      JOIN orders o ON v.order_id = o.id
      JOIN deals d ON o.deal_id = d.id
      JOIN users u ON d.merchant_id = u.id

      WHERE v.redeemed = true
        AND v.payout_id IS NULL
        AND v.redeemed_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' + INTERVAL '19 days'
        AND v.redeemed_at < date_trunc('month', CURRENT_DATE) + INTERVAL '19 days'

      GROUP BY u.id, u.name, u.nzbn
      ORDER BY merchant_amount DESC
    `);

    res.json({
      success: true,
      payouts_due: result.rows
    });

  } catch (err) {
    console.error('Payout due error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/payouts/send-summary', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id AS merchant_id,
        u.name AS merchant_name,
        u.nzbn,
        COUNT(v.id) AS redeemed_count,
        COALESCE(SUM(o.total_price), 0) AS redeemed_sales,
        COALESCE(SUM(o.total_price * (d.commission_percentage / 100.0)), 0) AS platform_commission,
        COALESCE(SUM(o.total_price * (1 - d.commission_percentage / 100.0)), 0) AS merchant_amount
      FROM vouchers v
      JOIN orders o ON v.order_id = o.id
      JOIN deals d ON o.deal_id = d.id
      JOIN users u ON d.merchant_id = u.id
      WHERE v.redeemed = true
        AND v.payout_id IS NULL
        AND v.redeemed_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' + INTERVAL '19 days'
        AND v.redeemed_at < date_trunc('month', CURRENT_DATE) + INTERVAL '19 days'
      GROUP BY u.id, u.name, u.nzbn
      ORDER BY merchant_amount DESC
    `);

    const rows = result.rows;

    const totalRedeemedSales = rows.reduce(
      (sum, row) => sum + Number(row.redeemed_sales || 0),
      0
    );

    const totalCommission = rows.reduce(
      (sum, row) => sum + Number(row.platform_commission || 0),
      0
    );

    const totalMerchantAmount = rows.reduce(
      (sum, row) => sum + Number(row.merchant_amount || 0),
      0
    );

    const merchantLines = rows.length
      ? rows.map((row) =>
          `${row.merchant_name} (${row.nzbn || 'No NZBN'}) — Redeemed: ${row.redeemed_count} — Merchant Due: $${Number(row.merchant_amount).toFixed(2)}`
        ).join('<br>')
      : 'No unpaid redeemed vouchers found for this payout period.';

const emailResult = await resend.emails.send({
  from: 'onboarding@resend.dev',
  to: process.env.COMPANY_EMAIL,
  subject: 'Merchant payouts due on the 20th',
  html: `
    <h2>Merchant payouts due on the 20th</h2>
    <p><strong>Redeemed Sales in Period:</strong> $${totalRedeemedSales.toFixed(2)}</p>
    <p><strong>Platform Commission:</strong> $${totalCommission.toFixed(2)}</p>
    <p><strong>Merchant Amount Due:</strong> $${totalMerchantAmount.toFixed(2)}</p>
    <hr>
    <p>${merchantLines}</p>
  `,
});

console.log('EMAIL RESULT:', emailResult);

if (emailResult.error) {
  console.error('Resend error:', emailResult.error);
  return res.status(400).json({
    success: false,
    message: emailResult.error.message || 'Failed to send email',
  });
}

    res.json({ success: true, message: 'Payout summary email sent' });
  } catch (err) {
    console.error('Send payout summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/payouts/mark-paid', authenticateAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const payoutsResult = await client.query(`
      SELECT
        u.id AS merchant_id,
        COUNT(v.id) AS redeemed_count,
        COALESCE(SUM(o.total_price), 0) AS redeemed_sales,
        COALESCE(SUM(o.total_price * (d.commission_percentage / 100.0)), 0) AS platform_commission,
        COALESCE(SUM(o.total_price * (1 - d.commission_percentage / 100.0)), 0) AS merchant_amount
      FROM vouchers v
      JOIN orders o ON v.order_id = o.id
      JOIN deals d ON o.deal_id = d.id
      JOIN users u ON d.merchant_id = u.id
      WHERE v.redeemed = true
        AND v.payout_id IS NULL
        AND v.redeemed_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' + INTERVAL '19 days'
        AND v.redeemed_at < date_trunc('month', CURRENT_DATE) + INTERVAL '19 days'
      GROUP BY u.id
      ORDER BY u.id
    `);

    const payouts = payoutsResult.rows;

    if (payouts.length === 0) {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        message: 'No unpaid redeemed vouchers found for this payout period'
      });
    }

    for (const row of payouts) {
      const payoutInsert = await client.query(
        `
          INSERT INTO merchant_payouts (
            merchant_id,
            period_start,
            period_end,
            redeemed_count,
            redeemed_sales,
            platform_commission,
            merchant_amount,
            status
          )
          VALUES (
            $1,
            date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' + INTERVAL '19 days',
            date_trunc('month', CURRENT_DATE) + INTERVAL '19 days' - INTERVAL '1 second',
            $2,
            $3,
            $4,
            $5,
            'paid'
          )
          RETURNING id
        `,
        [
          row.merchant_id,
          row.redeemed_count,
          row.redeemed_sales,
          row.platform_commission,
          row.merchant_amount
        ]
      );

      const payoutId = payoutInsert.rows[0].id;

      await client.query(
        `
          UPDATE vouchers v
          SET payout_id = $1
          FROM orders o, deals d
          WHERE v.order_id = o.id
            AND o.deal_id = d.id
            AND d.merchant_id = $2
            AND v.redeemed = true
            AND v.payout_id IS NULL
            AND v.redeemed_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' + INTERVAL '19 days'
            AND v.redeemed_at < date_trunc('month', CURRENT_DATE) + INTERVAL '19 days'
        `,
        [payoutId, row.merchant_id]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Payout batch marked as paid successfully',
      merchants_processed: payouts.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Mark payouts paid error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

router.get('/payouts/history', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        mp.id,
        mp.merchant_id,
        u.name AS merchant_name,
        u.nzbn,
        mp.period_start,
        mp.period_end,
        mp.redeemed_count,
        mp.redeemed_sales,
        mp.platform_commission,
        mp.merchant_amount,
        mp.status,
        mp.created_at
      FROM merchant_payouts mp
      JOIN users u ON mp.merchant_id = u.id
      ORDER BY mp.created_at DESC, mp.id DESC
    `);

    res.json({
      success: true,
      payouts: result.rows
    });
  } catch (err) {
    console.error('Get payout history error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;