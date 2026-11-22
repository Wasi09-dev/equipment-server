import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import dns from 'node:dns';
import { MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
const app = express();
const port = process.env.PORT || 5000;
dns.setServers(['8.8.8.8', '1.1.1.1']) 
app.use(express.json());
app.use(cors());


const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.czr1hjo.mongodb.net/`);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db('equipmentdb');
const users = db.collection('user')
const gears = db.collection('gear')
const bookings = db.collection('bookings')

// stripeSessionId is the idempotency key: one booking per paid Checkout Session.
try {
  await bookings.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true });
} catch (error) {
  console.error('Could not create bookings index:', error.message);
}


// One-time/admin routes require a secret header so normal users cannot call them.
const requireAdminKey = (req, res, next) => {
  const expected = process.env.ADMIN_SETUP_KEY;
  const provided = req.headers["x-admin-key"];
  if (!expected || provided !== expected) {
    return res.status(403).send({
      message:
        "Forbidden: set ADMIN_SETUP_KEY on the server and send it as x-admin-key.",
    });
  }
  next();
};

app.get('/users', requireAdminKey, async (req, res) =>{
const cursor = users.find({});
const result = await cursor.toArray();
res.send(result);
})

const getCaller = async (req) => {
  const email = req.headers["x-user-email"];
  if (!email) return null;
  return users.findOne({ email });
};

const userFilter = (id) =>
  ObjectId.isValid(id)
    ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
    : { _id: id };

app.patch("/users/:id/role", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller || caller.role !== "admin") {
    return res.status(403).send({ message: "Admins only" });
  }

  const { role } = req.body;
  if (!["customer", "owner", "admin"].includes(role)) {
    return res.status(400).send({ message: "Invalid role" });
  }

  const target = await users.findOne(userFilter(req.params.id));
  if (!target) return res.status(404).send({ message: "User not found" });
  if (target.email === caller.email) {
    return res.status(400).send({ message: "You can't change your own role" });
  }

  const result = await users.updateOne({ _id: target._id }, { $set: { role } });
  res.send(result);
});

app.patch("/users/:id/ban", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller || caller.role !== "admin") {
    return res.status(403).send({ message: "Admins only" });
  }

  const { banned } = req.body;
  if (typeof banned !== "boolean") {
    return res.status(400).send({ message: "banned must be true or false" });
  }

  const target = await users.findOne(userFilter(req.params.id));
  if (!target) return res.status(404).send({ message: "User not found" });
  if (target.email === caller.email) {
    return res.status(400).send({ message: "You can't ban yourself" });
  }

  const result = await users.updateOne({ _id: target._id }, { $set: { banned } });
  res.send(result);
});

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toArray = (value) => (Array.isArray(value) ? value : [value]);


const asNumber = (field) => ({
  $convert: { input: field, to: "double", onError: 0, onNull: 0 },
});

const hasValue = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const todayISO = () => new Date().toISOString().slice(0, 10);

app.get("/gears/categories", async (req, res) => {
  const categories = await gears.distinct("category");
  res.send(categories);
});

app.get("/gears/popular", async (req, res) => {
  const result = await gears
    .find({})
    .sort({ _id: -1 })
 .limit(5)
    .toArray();
  res.send(result);
});

app.get("/gears/:id", async (req, res) => {
  const id = req.params.id;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid id" });
  }

  const result = await gears.findOne({ _id: new ObjectId(id) });
  if (!result) {
    return res.status(404).send({ message: "Not found" });
  }
  res.send(result);
});

app.get("/gears", async (req, res) => {
  const {
    category,
    location,
    rentalType,
    minPrice,
    maxPrice,
    available,
    search,
    ownerEmail,
    page,
    limit,
  } = req.query;

  const filters = [];
  if (search) {
    const pattern = { $regex: escapeRegex(String(search)), $options: "i" };
    filters.push({
      $or: [
        { equipmentName: pattern },
        { category: pattern },
        { brand: pattern },
      ],
    });
  }
  if (category) {
    filters.push({ category: { $in: toArray(category) } });
  }
  if (location) {
    filters.push({
      location: { $regex: escapeRegex(String(location)), $options: "i" },
    });
  }
  // Rental type (Daily / Weekly / Monthly)
  if (rentalType) {
    const types = toArray(rentalType).map(
      (t) => new RegExp(`^${escapeRegex(String(t))}$`, "i")
    );
    filters.push({ rentalType: { $in: types } });
  }

  // Price range
  if (minPrice) {
    filters.push({
      $expr: { $gte: [asNumber("$rentalPrice"), Number(minPrice)] },
    });
  }
  if (maxPrice) {
    filters.push({
      $expr: { $lte: [asNumber("$rentalPrice"), Number(maxPrice)] },
    });
  }

  // Available only (stock > 0)
  if (available === "true") {
    filters.push({ $expr: { $gt: [asNumber("$quantity"), 0] } });
  }

  // Owner dashboard filter (exact match, empty strings ignored).
  if (hasValue(ownerEmail)) {
    filters.push({ ownerEmail: String(ownerEmail).trim() });
  }

  const query = filters.length ? { $and: filters } : {};

  try {
    // Plain array for existing consumers (owner list, popular, etc.).
    if (page === undefined && limit === undefined) {
      const result = await gears.find(query).sort({ _id: -1 }).toArray();
      return res.send(result);
    }

    // Paginated response for the public All Equipment page.
    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 9));
    const total = await gears.countDocuments(query);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const items = await gears
      .find(query)
      .sort({ _id: -1 })
      .skip((currentPage - 1) * perPage)
      .limit(perPage)
      .toArray();

    res.send({ items, total, page: currentPage, limit: perPage, totalPages });
  } catch (error) {
    console.error("Failed to load gear:", error);
    res.status(500).send({ message: "Failed to load gear" });
  }
});


app.post('/gears', async (req, res) => {
  const gear = req.body || {};

  if (!hasValue(gear.ownerEmail)) {
    return res.status(400).send({ message: 'ownerEmail is required' });
  }
  if (!hasValue(gear.equipmentName)) {
    return res.status(400).send({ message: 'equipmentName is required' });
  }

  try {
    const result = await gears.insertOne({
      ...gear,
      ownerEmail: String(gear.ownerEmail).trim(),
      ownerName: hasValue(gear.ownerName) ? String(gear.ownerName).trim() : null,
    });
    res.send(result);
  } catch (error) {
    console.error('Failed to create equipment:', error);
    res.status(500).send({ message: 'Failed to create equipment' });
  }
});

const GEAR_EDITABLE_FIELDS = [
  'equipmentName',
  'category',
  'description',
  'rentalPrice',
  'rentalType',
  'quantity',
  'brand',
  'model',
  'condition',
  'location',
  'imageUrls',
  'rentalTerms',
];

app.put('/gears/:id', async (req, res) => {
  const { id } = req.params;
  const { ownerEmail } = req.query;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: 'Invalid id' });
  }

  try {
    const gear = await gears.findOne({ _id: new ObjectId(id) });
    if (!gear) {
      return res.status(404).send({ message: 'Not found' });
    }
    if (
      !hasValue(ownerEmail) ||
      normalizeEmail(gear.ownerEmail) !== normalizeEmail(ownerEmail)
    ) {
      return res.status(403).send({ message: 'You can only edit your own equipment' });
    }

    const updates = {};
    for (const field of GEAR_EDITABLE_FIELDS) {
      if (req.body?.[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).send({ message: 'No fields to update' });
    }

    await gears.updateOne({ _id: gear._id }, { $set: updates });
    res.send({ ...gear, ...updates });
  } catch (error) {
    console.error('Failed to update equipment:', error);
    res.status(500).send({ message: 'Failed to update equipment' });
  }
});

app.delete('/gears/:id', async (req, res) => {
  const { id } = req.params;
  const { ownerEmail } = req.query;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: 'Invalid id' });
  }

  try {
    const gear = await gears.findOne({ _id: new ObjectId(id) });
    if (!gear) {
      return res.status(404).send({ message: 'Not found' });
    }
    if (
      !hasValue(ownerEmail) ||
      normalizeEmail(gear.ownerEmail) !== normalizeEmail(ownerEmail)
    ) {
      return res.status(403).send({ message: 'You can only delete your own equipment' });
    }

    const result = await gears.deleteOne({ _id: gear._id });
    res.send(result);
  } catch (error) {
    console.error('Failed to delete equipment:', error);
    res.status(500).send({ message: 'Failed to delete equipment' });
  }
});

app.get('/owner/stats', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) {
    return res.status(400).send({ message: 'email is required' });
  }

  try {
    const [totalEquipment, totalBookings, upcomingBookings, earnings] =
      await Promise.all([
        gears.countDocuments({ ownerEmail: email }),
        bookings.countDocuments({ ownerEmail: email }),
        bookings.countDocuments({
          ownerEmail: email,
          bookingStatus: { $ne: 'cancelled' },
          startDate: { $gte: todayISO() },
        }),
        bookings
          .aggregate([
            { $match: { ownerEmail: email, paymentStatus: 'paid' } },
            { $group: { _id: null, total: { $sum: asNumber('$totalAmount') } } },
          ])
          .toArray(),
      ]);

    res.send({
      totalEquipment,
      totalBookings,
      totalEarnings: earnings[0]?.total || 0,
      upcomingBookings,
    });
  } catch (error) {
    console.error('Failed to load owner stats:', error);
    res.status(500).send({ message: 'Failed to load owner stats' });
  }
});

const firstImage = (gear) =>
  String(gear?.imageUrls || "")
    .split(/[\n,]+/)
    .map((url) => url.trim())
    .find(Boolean) || "";

app.get('/bookings', async (req, res) => {
  const { email, ownerEmail, status } = req.query;

  // Empty strings count as missing.
  const filter = {};
  if (hasValue(email)) {
    filter.customerEmail = String(email).trim();
  } else if (hasValue(ownerEmail)) {
    filter.ownerEmail = String(ownerEmail).trim();
  } else {
    return res.status(400).send({ message: 'email or ownerEmail is required' });
  }

  if (hasValue(status) && String(status).toLowerCase() !== 'all') {
    filter.bookingStatus = String(status).toLowerCase();
  }

  try {
    const result = await bookings
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error('Failed to load bookings:', error);
    res.status(500).send({ message: 'Failed to load bookings' });
  }
});

app.post('/bookings', async (req, res) => {
  const booking = req.body || {};
  const { stripeSessionId } = booking;

  if (!stripeSessionId) {
    return res.status(400).send({ message: 'stripeSessionId is required' });
  }

  try {
    const existing = await bookings.findOne({ stripeSessionId });
    if (existing) {
      return res.send({ inserted: false, booking: existing });
    }

    const { equipmentId } = booking;
    const gear =
      equipmentId && ObjectId.isValid(equipmentId)
        ? await gears.findOne({ _id: new ObjectId(equipmentId) })
        : null;

    const quantity = Math.max(1, Number(booking.quantity) || 1);

    // Owner details always come from the equipment document, never the browser.
    const ownerEmail = hasValue(gear?.ownerEmail)
      ? String(gear.ownerEmail).trim()
      : null;
    const ownerName = hasValue(gear?.ownerName)
      ? String(gear.ownerName).trim()
      : null;

    const doc = {
      ...booking,
      equipmentName: gear?.equipmentName || booking.equipmentName || 'Equipment rental',
      image: firstImage(gear) || booking.image || '',
      ownerEmail,
      ownerName,
      quantity,
      paymentStatus: booking.paymentStatus || 'paid',
      bookingStatus: booking.bookingStatus || 'confirmed',
      createdAt: booking.createdAt || new Date().toISOString(),
    };

    let result;
    try {
      result = await bookings.insertOne(doc);
    } catch (error) {
      // Unique index hit: a parallel request already saved this session.
      if (error.code === 11000) {
        const saved = await bookings.findOne({ stripeSessionId });
        return res.send({ inserted: false, booking: saved });
      }
      throw error;
    }

    // Decrease stock only after a brand-new booking is inserted (once per session).
    // quantity is stored as a string, so convert and write it back as a string.
    if (gear) {
      const currentStock = Number(gear.quantity) || 0;
      const nextStock = Math.max(0, currentStock - quantity);
      await gears.updateOne(
        { _id: gear._id },
        { $set: { quantity: String(nextStock) } }
      );
    }

    res.send({ inserted: true, booking: { ...doc, _id: result.insertedId } });
  } catch (error) {
    console.error('Failed to save booking:', error);
    res.status(500).send({ message: 'Failed to save booking' });
  }
});


// ---------------------------------------------------------------------------
// Admin-only maintenance routes (require x-admin-key: ADMIN_SETUP_KEY)
// ---------------------------------------------------------------------------

// Run this ONCE before backfill-bookings.
app.post('/admin/assign-owner', requireAdminKey, async (req, res) => {
  const { ownerEmail, ownerName } = req.body || {};

  if (!hasValue(ownerEmail)) {
    return res.status(400).send({ message: 'ownerEmail is required' });
  }

  try {
    const result = await gears.updateMany(
      {
        $or: [
          { ownerEmail: { $exists: false } },
          { ownerEmail: null },
          { ownerEmail: { $regex: /^\s*$/ } },
        ],
      },
      {
        $set: {
          ownerEmail: String(ownerEmail).trim(),
          ownerName: hasValue(ownerName) ? String(ownerName).trim() : null,
        },
      }
    );

    res.send({ matched: result.matchedCount, modified: result.modifiedCount });
  } catch (error) {
    console.error('Failed to assign owner:', error);
    res.status(500).send({ message: 'Failed to assign owner' });
  }
});

// Run this ONCE after assign-owner.
app.post('/admin/backfill-bookings', requireAdminKey, async (req, res) => {
  let updated = 0;
  let skipped = 0;

  try {
    const cursor = bookings.find({
      $or: [
        { ownerEmail: { $exists: false } },
        { ownerEmail: null },
        { ownerEmail: { $regex: /^\s*$/ } },
      ],
    });

    for await (const booking of cursor) {
      if (!booking.equipmentId || !ObjectId.isValid(booking.equipmentId)) {
        skipped += 1;
        continue;
      }

      const gear = await gears.findOne({
        _id: new ObjectId(booking.equipmentId),
      });

      if (!hasValue(gear?.ownerEmail)) {
        skipped += 1;
        continue;
      }

      await bookings.updateOne(
        { _id: booking._id },
        {
          $set: {
            ownerEmail: String(gear.ownerEmail).trim(),
            ownerName: hasValue(gear.ownerName)
              ? String(gear.ownerName).trim()
              : null,
          },
        }
      );
      updated += 1;
    }

    res.send({ updated, skipped });
  } catch (error) {
    console.error('Failed to backfill bookings:', error);
    res.status(500).send({ message: 'Failed to backfill bookings' });
  }
});

// Read-only platform bookings for the admin dashboard.
app.get('/admin/bookings', requireAdminKey, async (req, res) => {
  try {
    const result = await bookings
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error('Failed to load admin bookings:', error);
    res.status(500).send({ message: 'Failed to load bookings' });
  }
});

app.get('/', (req, res) => {
  res.send('hello world');
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});