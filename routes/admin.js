const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authenticateAdmin = require('../middleware/authenticateAdmin');

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

module.exports = router;