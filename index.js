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

app.get('/users', async (req, res) =>{
const cursor = users.find({});
const result = await cursor.toArray();
res.send(result);
})


const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toArray = (value) => (Array.isArray(value) ? value : [value]);


const asNumber = (field) => ({
  $convert: { input: field, to: "double", onError: 0, onNull: 0 },
});

app.get("/gears/categories", async (req, res) => {
  const categories = await gears.distinct("category");
  res.send(categories);
});

app.get("/gears", async (req, res) => {
  const { category, location, rentalType, minPrice, maxPrice, available ,search } =
    req.query;

  const filters = [];
if (search) {
  const pattern = { $regex: escapeRegex(search), $options: "i" };
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
      location: { $regex: escapeRegex(location), $options: "i" },
    });
  }

  // Rental type (Daily / Weekly / Monthly)
  if (rentalType) {
    const types = toArray(rentalType).map(
      (t) => new RegExp(`^${escapeRegex(t)}$`, "i")
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

  const query = filters.length ? { $and: filters } : {};
  console.log("filter query:", JSON.stringify(query));

  const result = await gears.find(query).toArray();
  res.send(result);
});


app.post('/gears',async (req,res)=>{
  const gear = req.body;
  const result = await gears.insertOne(gear);
  res.send(result);
   
})

app.delete('/gears/:id', async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await gears.deleteOne(query);

  res.send(result);
});

app.get('/', (req, res) => {
  res.send('hello world');
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});