# Stock import script

## import-stock-csvs.mjs

Reads all CSV files from `stock files/`, assigns **vendor** (Starlink / Fortinet) and **product name** from filename and optional header row, and outputs seed data with `device_type` / `device_type_id` / `vendor` columns.

**Run:**
```bash
node scripts/import-stock-csvs.mjs
```

**Output:**
- `data/stock-seed.json` – array of inventory items (id, serial_number, device_type, device_type_id, name, vendor, status, date_added, location) for app or API import
- `data/stock-seed.sql` – `INSERT ... ON CONFLICT DO NOTHING` statements for Supabase

**Rules:**
- Vendor: filename contains `Forti` or `48_port` → Fortinet; otherwise Starlink
- Product name: from filename (e.g. `Standard_Kits.csv` → "Standard Kits") or from first row when it looks like a header
- `FortiSwitch_108f.csv`: two columns → two product types ("Fortiswitch 108f", "Fortiswitch 108f fpoe")

After running, use the JSON or SQL to seed your Supabase `inventory_items` table (or import via the app when you add an import feature).
