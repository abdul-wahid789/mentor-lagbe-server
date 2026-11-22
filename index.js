import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 5000;
const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(
  /\/$/,
  ""
);
const serverUrl = (
  process.env.SERVER_URL || `http://localhost:${port}`
).replace(/\/$/, "");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const client = new MongoClient(process.env.MONGO_URI);
let db;

const PRICE_MAP = {
  "pro-tutor": "price_1UeZUADFymDwkkLJwq4vjP6v",
  "pro-student": "price_1UeaUMDFymDwkkLJ6nIP06Fk",
};

const PLAN_LABELS = {
  "pro-student": "Pro Student",
  "pro-tutor": "Pro Tutor",
};

export async function connectToMongoDB() {
  if (db) return db;
  await client.connect();
  db = client.db("mentor-lagbe");
  console.log("Connected to MongoDB Atlas (mentor-lagbe)");
  return db;
}

export async function disconnectFromMongoDB() {
  await client.close();
  db = null;
}

connectToMongoDB().catch(console.error);

function buildUserFilter(userId, email) {
  const conditions = [];
  if (userId) {
    conditions.push({ id: String(userId) });
    if (ObjectId.isValid(String(userId))) {
      conditions.push({ _id: new ObjectId(String(userId)) });
    }
  }
  if (email) {
    conditions.push({ email: String(email).toLowerCase() });
  }
  if (conditions.length === 0) return null;
  return conditions.length === 1 ? conditions[0] : { $or: conditions };
}

function formatDate(date = new Date()) {
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

async function savePaymentAndUpgradeUser(session, fallbackPlan = "pro-tutor") {
  const meta = session.metadata || {};
  const database = await connectToMongoDB();
  const paymentsCol = database.collection("payments");
  const usersCol = database.collection("user");

  const planKey = meta.plan || fallbackPlan;
  const planName = PLAN_LABELS[planKey] || "Pro Tutor";
  const amountNum = Number(((session.amount_total || 0) / 100).toFixed(2));
  const currency = (session.currency || "usd").toUpperCase();
  const transactionId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.id;
  const userEmail = (
    meta.userEmail ||
    session.customer_details?.email ||
    ""
  ).toLowerCase();
  const paidAt = formatDate(
    session.created ? new Date(session.created * 1000) : new Date()
  );

  const existing = await paymentsCol.findOne({ transactionId });
  if (!existing) {
    await paymentsCol.insertOne({
      userId: meta.userId || "",
      userName: meta.userName || session.customer_details?.name || "Member",
      userEmail,
      role: meta.role || (planKey === "pro-student" ? "student" : "tutor"),
      plan: planKey,
      planName,
      amount: amountNum,
      currency,
      transactionId,
      status: session.payment_status || "paid",
      paidAt,
      createdAt: new Date().toISOString(),
    });
  }

  const userFilter = buildUserFilter(meta.userId, userEmail);
  if (userFilter) {
    await usersCol.updateOne(userFilter, { $set: { plan: "pro" } });
  }

  return {
    plan: planKey,
    amount: `$${amountNum.toFixed(2)} ${currency}`,
    tx: transactionId,
    paidAt,
    email: userEmail,
  };
}

app.use(
  cors({
    origin: clientUrl,
    credentials: true,
  })
);
app.use(express.json());

const JWKS = createRemoteJWKSet(new URL(`${clientUrl}/api/auth/jwks`));

export async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token) {
      return res
        .status(401)
        .json({ error: true, msg: "Missing or invalid token" });
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: clientUrl,
      audience: clientUrl,
    });

    req.user = {
      id: payload.sub || payload.id,
      role: payload.role || "student",
      email: payload.email || "",
      name: payload.name || "",
    };

    return next();
  } catch (err) {
    return res
      .status(401)
      .json({ error: true, msg: "Token verification failed" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: true, msg: "Forbidden: insufficient role" });
    }
    return next();
  };
}

app.get("/", (req, res) => {
  res.send("Hello from Mentor Lagbe Server");
});

// Step 1: Create Stripe Checkout session and return URL to CheckoutCard
app.post("/checkout", verifyToken, async (req, res) => {
  try {
    const plan =
      req.body?.plan === "pro-student" ? "pro-student" : "pro-tutor";
    const priceId = PRICE_MAP[plan] || PRICE_MAP["pro-tutor"];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user?.email || undefined,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId: String(req.user?.id || ""),
        userEmail: String(req.user?.email || ""),
        userName: String(req.user?.name || ""),
        role: String(req.user?.role || (plan === "pro-student" ? "student" : "tutor")),
        plan,
      },
      success_url: `${serverUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${serverUrl}/payment/cancel?plan=${plan}`,
    });

    return res.status(200).json({
      data: session.url,
      error: false,
      msg: "Redirecting to Stripe",
    });
  } catch (err) {
    console.error("Checkout error:", err);
    return res
      .status(500)
      .json({ error: true, msg: "Failed to create checkout session" });
  }
});

// Step 2a: Stripe redirects here after successful payment -> saves DB & redirects to Next.js UI with params
app.get("/payment/success", async (req, res) => {
  const plan = req.query.plan === "pro-student" ? "pro-student" : "pro-tutor";
  const sessionId = String(req.query.session_id || "");

  if (!sessionId) {
    return res.redirect(`${clientUrl}/payment/cancel?plan=${plan}`);
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.redirect(`${clientUrl}/payment/cancel?plan=${plan}`);
    }

    const saved = await savePaymentAndUpgradeUser(session, plan);
    const params = new URLSearchParams({
      plan: saved.plan,
      amount: saved.amount,
      tx: saved.tx,
      paidAt: saved.paidAt,
      email: saved.email,
    });

    return res.redirect(`${clientUrl}/payment/success?${params.toString()}`);
  } catch (err) {
    console.error("Payment success handler error:", err);
    return res.redirect(`${clientUrl}/payment/cancel?plan=${plan}`);
  }
});

// Step 2b: Optional POST /payment/success endpoint if called directly from client/server
app.post("/payment/success", verifyToken, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || req.body?.session_id || "");
    const plan = req.body?.plan === "pro-student" ? "pro-student" : "pro-tutor";

    if (!sessionId) {
      return res.status(400).json({ error: true, msg: "Missing sessionId" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: true, msg: "Payment not paid" });
    }

    const saved = await savePaymentAndUpgradeUser(session, plan);
    return res.status(200).json({
      error: false,
      msg: "Payment saved and plan upgraded to Pro",
      data: saved,
    });
  } catch (err) {
    console.error("POST /payment/success error:", err);
    return res
      .status(500)
      .json({ error: true, msg: "Failed to save payment" });
  }
});

// Step 2c: Stripe redirects here when user cancels -> redirects to Next.js /payment/cancel
app.get("/payment/cancel", (req, res) => {
  const plan = req.query.plan === "pro-student" ? "pro-student" : "pro-tutor";
  return res.redirect(`${clientUrl}/payment/cancel?plan=${plan}`);
});

// Read all transactions from MongoDB Atlas
app.get("/transactions", verifyToken, async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const docs = await database
      .collection("payments")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const formatted = docs.map((d) => ({
      id: String(d._id),
      userName: d.userName || "Member",
      userEmail: d.userEmail || "",
      role: d.role || "tutor",
      planName: d.planName || "Pro Tutor",
      amount: Number(d.amount || 0),
      currency: d.currency || "USD",
      transactionId: d.transactionId || "",
      paidAt: d.paidAt || "",
    }));

    return res.status(200).json({
      error: false,
      msg: "Transactions fetched",
      data: formatted,
    });
  } catch (err) {
    console.error("Fetch transactions error:", err);
    return res
      .status(500)
      .json({ error: true, msg: "Failed to fetch transactions" });
  }
});

app.post("/tuition", verifyToken, requireRole("tutor"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const tuitionsCol = database.collection("tuitions");

    const userDoc = await database
      .collection("user")
      .findOne(buildUserFilter(req.user.id, req.user.email));

    const isPro = userDoc?.plan === "pro";
    if (!isPro) {
      const count = await tuitionsCol.countDocuments({
        tutorId: req.user.id,
      });
      if (count >= 2) {
        return res.status(403).json({
          error: true,
          msg: "Free plan allows up to 2 tuition posts. Upgrade to Pro for unlimited posts.",
        });
      }
    }

    const newTuition = {
      ...req.body,
      tutorId: req.user.id,
      tutorName: req.user.name,
      tutorEmail: req.user.email,
      approvalStatus: "pending",
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    const result = await tuitionsCol.insertOne(newTuition);
    return res.status(201).json({
      error: false,
      msg: "Tuition added successfully",
      id: result.insertedId,
    });
  } catch (err) {
    console.error("Create tuition error:", err);
    return res.status(500).json({ error: true, msg: "Failed to create tuition" });
  }
});

app.listen(port, () => {
  console.log(`Mentor Lagbe server running on port ${port}`);
});