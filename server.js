// server.js - FINAL (Turso Cloud Version)
// Siap untuk Vercel / Render / Hosting Modern

require('dotenv').config(); // Load password dari file .env
const express = require('express');
const { createClient } = require('@libsql/client'); // Driver Turso
const cors = require('cors');
const fetch = require('node-fetch'); // Pastikan pakai node-fetch v2 jika error import
const { URL } = require('url');

const app = express();
const port = process.env.PORT || 8080; // Biar hosting yang tentukan portnya

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 1. KONEKSI KE TURSO (Bukan file lokal lagi)
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxCpzF6e3ii_aAPaFmU2bhlaeskNlUeIgJdZSo1wnECGhNaUoVVfinlhyE2W5MKwj83eg/exec';
const SCRIPT_TOKEN = 'L0k3rS3cr3t2025!#';

// 2. FUNGSI INISIALISASI DATABASE (Disesuaikan untuk Turso)
async function initializeDatabase() {
    console.log("🔄 Menghubungkan ke Turso Cloud...");

    // Buat Tabel Lockers
    await db.execute(`
        CREATE TABLE IF NOT EXISTS lockers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ownerName TEXT,
            itemName TEXT,
            locationCode TEXT,
            locationType TEXT DEFAULT 'Locker',
            entryDate TEXT,
            expirationDate TEXT,
            status TEXT,
            keterangan TEXT,
            manualStatus TEXT,
            manualNote TEXT,
            fileIndex TEXT
        )
    `);

    // Buat Tabel Master Owners
    await db.execute(`CREATE TABLE IF NOT EXISTS master_owners (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`);

    // Buat Tabel Master Locations
    await db.execute(`CREATE TABLE IF NOT EXISTS master_locations (id INTEGER PRIMARY KEY, code TEXT UNIQUE, type TEXT, current_owner TEXT)`);

    console.log(`✅ Database Turso Siap. Server di port ${port}`);
}

// 🟢 EXPORT KHUSUS (Tetap jalan seperti biasa)
app.get('/api/lockers/export', async (req, res) => {
    const type = req.query.type;
    try {
        let sql = `
            SELECT 
                CASE WHEN locationType = 'Rack' THEN 'RK-' || id ELSE 'LK-' || id END AS "ID Sistem",
                locationCode AS "Kode Lokasi", 
                locationType AS "Tipe", 
                ownerName AS "Owner Name", 
                itemName AS "Item Name", 
                entryDate AS "Tanggal Masuk", 
                expirationDate AS "Tanggal Exp", 
                manualStatus AS "Status Manual", 
                manualNote AS "Keterangan Status", 
                keterangan AS "Keterangan",
                fileIndex AS "Index"
            FROM lockers
        `;

        const args = [];
        if (type) {
            sql += ` WHERE locationType = ?`;
            args.push(type);
        }

        // Di Turso, hasil query ada di properti .rows
        const result = await db.execute({ sql, args });
        const items = result.rows;

        // Sortir Manual (JavaScript)
        items.sort((a, b) => {
            const nA = parseInt((a["Kode Lokasi"] || "0").replace(/\D/g, ''));
            const nB = parseInt((b["Kode Lokasi"] || "0").replace(/\D/g, ''));
            return nA - nB;
        });

        const url = new URL(APPS_SCRIPT_URL);
        url.searchParams.append('key', SCRIPT_TOKEN);

        const resp = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items)
        });

        if (resp.ok) res.json({ msg: `Export ${type || 'ALL'} OK` });
        else throw new Error('Fail to send to Apps Script');
    } catch (e) { res.status(500).json({ error: e.message || e }); }
});

// API MASTER - SAVE LOCKER
app.post('/api/masters/save-locker', async (req, res) => {
    const { lockerNumber, ownerName, locationType, forceAcquire } = req.body;
    const type = locationType || 'Locker';

    // Turso support transaction via batch tapi untuk simpel kita pakai logika JS dulu
    // atau pakai db.transaction() jika library update, tapi kita pakai cara aman manual:
    
    try {
        // Cek Existing
        const checkRes = await db.execute({
            sql: 'SELECT * FROM master_locations WHERE code = ?',
            args: [lockerNumber]
        });
        const existing = checkRes.rows[0];

        if (existing) {
            if (existing.type !== type) {
                return res.json({ status: 'type_conflict', message: `Kode '${lockerNumber}' conflict.` });
            }
            if (existing.current_owner && existing.current_owner !== ownerName && ownerName && !forceAcquire) {
                return res.json({ status: 'conflict', owner: existing.current_owner });
            }
        }

        if (ownerName) {
            await db.execute({
                sql: 'INSERT OR IGNORE INTO master_owners(name) VALUES(?)',
                args: [ownerName]
            });
        }

        // Upsert di SQLite
        await db.execute({
            sql: `INSERT INTO master_locations (code, type, current_owner) VALUES (?, ?, ?) 
                  ON CONFLICT(code) DO UPDATE SET current_owner = ?, type = ?`,
            args: [lockerNumber, type, ownerName || null, ownerName || null, type]
        });

        if (forceAcquire || (existing && existing.current_owner !== ownerName && ownerName)) {
            await db.execute({
                sql: 'UPDATE lockers SET ownerName = ?, locationType = ? WHERE locationCode = ?',
                args: [ownerName, type, lockerNumber]
            });
        }

        res.json({ status: 'success' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/masters/check-locker', async (req, res) => {
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM master_locations WHERE code = ?',
            args: [req.body.lockerNumber]
        });
        const locker = result.rows[0];

        if (!locker) return res.json({ status: 'new' });
        if (!locker.current_owner) return res.json({ status: 'vacant' });
        return res.json({ status: 'occupied', owner: locker.current_owner });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/masters/:type/:value', async (req, res) => {
    const { type, value } = req.params;
    const v = decodeURIComponent(value);
    try {
        if (type === 'owner') {
            await db.execute({ sql: 'DELETE FROM master_owners WHERE name=?', args: [v] });
            await db.execute({ sql: 'UPDATE master_locations SET current_owner=NULL WHERE current_owner=?', args: [v] });
        } else {
            await db.execute({ sql: 'DELETE FROM master_locations WHERE code=?', args: [v] });
            await db.execute({ sql: 'DELETE FROM lockers WHERE locationCode=?', args: [v] });
        }
        res.json({ msg: 'Del' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/masters', async (req, res) => {
    const resOwners = await db.execute("SELECT name FROM master_owners WHERE name IS NOT NULL ORDER BY name ASC");
    const resLockers = await db.execute("SELECT code AS number, type, current_owner FROM master_locations");
    
    // Konversi rows Turso ke array biasa
    const l = resLockers.rows;
    l.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    
    res.json({ owners: resOwners.rows, lockers: l });
});

// API BARANG
app.get('/api/lockers', async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT *, locationCode AS lockerNumber, fileIndex AS fileIdx FROM lockers
        `);
        
        const items = result.rows.map(r => ({
            ...r,
            index: r.fileIdx 
        }));

        items.sort((a, b) => 
            (a.lockerNumber || '').localeCompare(b.lockerNumber || '', undefined, { numeric: true })
        );

        res.json(items);
    } catch (e) {
        console.error("ERR /api/lockers:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/lockers', async (req, r) => {
    const { ownerName, itemName, lockerNumber, locationType, entryDate, expirationDate, keterangan, index } = req.body;
    try {
        await db.execute({
            sql: `INSERT INTO lockers (ownerName, itemName, locationCode, locationType, entryDate, expirationDate, keterangan, manualStatus, manualNote, fileIndex)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`,
            args: [ownerName, itemName, lockerNumber, locationType || 'Locker', entryDate, expirationDate, keterangan, "Auto", "", index || null]
        });
        r.json({ msg: 'Ok' });
    } catch (e) { r.status(500).json({ error: e.message }); }
});

app.put('/api/lockers/:id', async (req, r) => {
    const { ownerName, itemName, lockerNumber, locationType, entryDate, expirationDate, keterangan, manualStatus, manualNote, index } = req.body;
    try {
        await db.execute({
            sql: `UPDATE lockers SET ownerName=?, itemName=?, locationCode=?, locationType=?, entryDate=?, expirationDate=?, keterangan=?, manualStatus=?, manualNote=?, fileIndex=?
                  WHERE id=?`,
            args: [ownerName, itemName, lockerNumber, locationType, entryDate, expirationDate, keterangan, manualStatus, manualNote, index || null, req.params.id]
        });
        r.json({ msg: 'Upd' });
    } catch (e) { r.status(500).json({ error: e.message }); }
});

app.delete('/api/lockers/:id', async (req, r) => {
    try {
        await db.execute({ sql: 'DELETE FROM lockers WHERE id=?', args: [req.params.id] });
        r.json({ msg: 'Del' });
    } catch (e) { r.status(500).json({ error: e.message }); }
});

app.post('/api/masters/owner', async (req, r) => {
    if (!req.body.name) return r.status(400).json({ error: 'Missing name' });
    try {
        await db.execute({ sql: 'INSERT OR IGNORE INTO master_owners(name) VALUES(?)', args: [req.body.name.trim()] });
        r.json({ msg: 'Ok' });
    } catch (e) { r.status(500).json({ error: e.message }); }
});

// Jalankan Server
initializeDatabase().then(() => { 
    app.listen(port, () => console.log(`🚀 Server Turso Ready on port ${port}`)); 
  
});
module.exports = app;