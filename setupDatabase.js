require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  try {
    // 1️⃣ Users table (admins + merchants)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE,
        password VARCHAR(255),
        role VARCHAR(20) NOT NULL, -- 'admin' or 'merchant'
        nzbn VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

// 2️⃣ Customers table
await pool.query(`
  CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(100) UNIQUE,
    phone_number VARCHAR(20) UNIQUE,
    password TEXT,
    oauth_provider VARCHAR(20),
    oauth_id VARCHAR(255) UNIQUE,
    email_verified BOOLEAN DEFAULT false,
    phone_verified BOOLEAN DEFAULT false,
    marketing_email_consent BOOLEAN DEFAULT false,
    marketing_sms_consent BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
  )
`);

// Add new columns safely
try {
  await pool.query(`ALTER TABLE customers ADD COLUMN phone_number VARCHAR(20) UNIQUE`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN password TEXT`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN email_verified BOOLEAN DEFAULT false`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN phone_verified BOOLEAN DEFAULT false`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN marketing_email_consent BOOLEAN DEFAULT false`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN marketing_sms_consent BOOLEAN DEFAULT false`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN email_verification_code TEXT`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN email_verification_expires TIMESTAMP`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN phone_verification_code TEXT`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN phone_verification_expires TIMESTAMP`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN password_reset_code TEXT`);
} catch (err) {}

try {
  await pool.query(`ALTER TABLE customers ADD COLUMN password_reset_expires TIMESTAMP`);
} catch (err) {}

    // 3️⃣ Deals table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL,
        commission_percentage NUMERIC(5,2) DEFAULT 25,
        merchant_id INT NOT NULL,
        image_url TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (merchant_id) REFERENCES users(id)
      )
    `);

    // 4️⃣ Orders table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INT NOT NULL,
        deal_id INT NOT NULL,
        total_price NUMERIC(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (deal_id) REFERENCES deals(id)
      )
    `);

    // 5️⃣ Vouchers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vouchers (
        id SERIAL PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        order_id INT NOT NULL,
        deal_id INT NOT NULL,
        redeemed BOOLEAN DEFAULT FALSE,
        redeemed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (deal_id) REFERENCES deals(id)
      )
    `);

    // 6️⃣ Categories table (optional for future filtering)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('All tables created successfully ✅');
    process.exit(0);
  } catch (err) {
    console.error('Error creating tables:', err);
    process.exit(1);
  }
}

setup();
