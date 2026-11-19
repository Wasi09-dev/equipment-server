import express from 'express';
import cors from 'cors';
import 'dotenv/config'
import { MongoClient } from 'mongodb';
const app = express();
const port = process.env.PORT || 5000;

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

app.post('/gears',async (req,res)=>{
  const gear = req.body;
  const result = await gears.insertOne(gear);
  res.send(result);
})



app.get('/', (req, res) => {
  res.send('hello world');
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});