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

const FREE_TUITION_LIMIT = 2;

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

app.post("/checkout", verifyToken, async (req, res) => {
  try {
    const plan =
      req.body?.plan === "pro-student" ? "pro-student" : "pro-tutor";
    const priceId = PRICE_MAP[plan] || PRICE_MAP["pro-tutor"];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user?.email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        userId: String(req.user?.id || ""),
        userEmail: String(req.user?.email || ""),
        userName: String(req.user?.name || ""),
        role: String(
          req.user?.role || (plan === "pro-student" ? "student" : "tutor")
        ),
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

app.get("/payment/cancel", (req, res) => {
  const plan = req.query.plan === "pro-student" ? "pro-student" : "pro-tutor";
  return res.redirect(`${clientUrl}/payment/cancel?plan=${plan}`);
});

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
      planName: d.planName === "Pro Student" ? "Pro Student" : "Pro Tutor",
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

app.get("/tuitions", async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const docs = await database
      .collection("tuitions")
      .find({ approvalStatus: "approved", isActive: { $ne: false } })
      .sort({ _id: -1 })
      .toArray();

    return res.status(200).json({
      error: false,
      msg: "Tuitions fetched",
      data: docs,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: true, msg: "Failed to fetch tuitions" });
  }
});

app.get("/tuitions/mine", verifyToken, requireRole("tutor"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const docs = await database
      .collection("tuitions")
      .find({
        $or: [
          { tutorId: String(req.user.id) },
          ...(req.user.email ? [{ tutorEmail: req.user.email }] : []),
        ],
      })
      .sort({ _id: -1 })
      .toArray();

    return res.status(200).json({
      error: false,
      msg: "Tutor tuitions fetched",
      data: docs,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: true, msg: "Failed to fetch your tuitions" });
  }
});

// Create tuition: checks Pro plan vs Free 2-post limit
app.post("/tuition", verifyToken, requireRole("tutor"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const tuitionsCol = database.collection("tuitions");

    const userDoc = await database
      .collection("user")
      .findOne(buildUserFilter(req.user.id, req.user.email));

    const isPro = userDoc?.plan === "pro";
    const existingCount = await tuitionsCol.countDocuments({
      $or: [
        { tutorId: String(req.user.id) },
        ...(req.user.email ? [{ tutorEmail: req.user.email }] : []),
      ],
    });

    if (!isPro && existingCount >= FREE_TUITION_LIMIT) {
      return res.status(403).json({
        error: true,
        msg: `Free plan allows up to ${FREE_TUITION_LIMIT} tuition posts (${existingCount}/${FREE_TUITION_LIMIT} used). Upgrade to Pro for unlimited posts.`,
      });
    }

    const newTuition = {
      ...req.body,
      tutorId: req.user.id,
      tutorName: req.user.name,
      tutorEmail: req.user.email,
      approvalStatus: "pending",
      isActive: true,
      applicantsCount: 0,
      createdAt: formatDate(new Date()),
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

app.patch("/tuition/:id", verifyToken, requireRole("tutor"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: true, msg: "Invalid tuition ID" });
    }

    const updated = await database.collection("tuitions").findOneAndUpdate(
      { _id: new ObjectId(id), tutorId: req.user.id },
      { $set: { ...req.body, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );

    if (!updated) {
      return res.status(404).json({ error: true, msg: "Tuition not found" });
    }

    return res.status(200).json({ error: false, msg: "Tuition updated" });
  } catch (err) {
    return res.status(500).json({ error: true, msg: "Failed to update tuition" });
  }
});

app.patch(
  "/tuition/:id/status",
  verifyToken,
  requireRole("tutor"),
  async (req, res) => {
    try {
      const database = await connectToMongoDB();
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: true, msg: "Invalid tuition ID" });
      }

      const updated = await database.collection("tuitions").findOneAndUpdate(
        { _id: new ObjectId(id), tutorId: req.user.id },
        { $set: { isActive: Boolean(req.body?.isActive) } },
        { returnDocument: "after" }
      );

      if (!updated) {
        return res.status(404).json({ error: true, msg: "Tuition not found" });
      }

      return res.status(200).json({ error: false, msg: "Status updated" });
    } catch (err) {
      return res.status(500).json({ error: true, msg: "Failed to update status" });
    }
  }
);

app.delete("/tuition/:id", verifyToken, requireRole("tutor"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: true, msg: "Invalid tuition ID" });
    }

    const deleted = await database
      .collection("tuitions")
      .deleteOne({ _id: new ObjectId(id), tutorId: req.user.id });

    if (deleted.deletedCount === 0) {
      return res.status(404).json({ error: true, msg: "Tuition not found" });
    }

    return res.status(200).json({ error: false, msg: "Tuition deleted" });
  } catch (err) {
    return res.status(500).json({ error: true, msg: "Failed to delete tuition" });
  }
});


app.get("/user/paid", verifyToken, async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const usersCol = database.collection("user");
    const paymentsCol = database.collection("payments");

    const userFilter = buildUserFilter(req.user.id, req.user.email);
    const userDoc = userFilter ? await usersCol.findOne(userFilter) : null;

    const paymentFilter = {
      $or: [
        ...(req.user.id ? [{ userId: String(req.user.id) }] : []),
        ...(req.user.email
          ? [{ userEmail: String(req.user.email).toLowerCase() }]
          : []),
      ],
    };

    const payments = await paymentsCol
      .find(paymentFilter)
      .sort({ createdAt: -1 })
      .toArray();

    const isPro = userDoc?.plan === "pro" || payments.length > 0;

    return res.status(200).json({
      error: false,
      msg: isPro ? "User has an active Pro plan" : "User is on the Free plan",
      data: {
        isPro,
        plan: isPro ? "pro" : "free",
        latestPayment: payments[0] || null,
        payments,
      },
    });
  } catch (err) {
    console.error("Check user paid status error:", err);
    return res
      .status(500)
      .json({ error: true, msg: "Failed to check payment status" });
  }
});

app.get(
  "/applications/tutor",
  verifyToken,
  requireRole("tutor"),
  async (req, res) => {
    try {
      const database = await connectToMongoDB();
      const applicationsCol = database.collection("applications");

      const tutorId = String(req.user?.id || "");
      const tutorEmail = String(req.user?.email || "").toLowerCase();

      const conditions = [];
      if (tutorId) {
        conditions.push({ tutorId });
      }
      if (tutorEmail) {
        conditions.push({ tutorEmail });
      }

      if (conditions.length === 0) {
        return res.status(200).json({
          error: false,
          msg: "Tutor applications fetched",
          data: [],
        });
      }

      const docs = await applicationsCol
        .find(conditions.length === 1 ? conditions[0] : { $or: conditions })
        .sort({ _id: -1 })
        .toArray();

      const formatted = docs.map((doc) => ({
        id: String(doc._id),
        tuitionId: String(doc.tuitionId || ""),
        tuitionTitle: String(doc.tuitionTitle || "Tuition"),
        tutorName: String(doc.tutorName || req.user?.name || ""),
        tutorEmail: String(doc.tutorEmail || tutorEmail),
        studentName: String(doc.studentName || "Student"),
        studentEmail: String(doc.studentEmail || ""),
        studentPhone: String(doc.studentPhone || ""),
        preferredSchedule: String(doc.preferredSchedule || ""),
        note: String(doc.note || ""),
        monthlyFee: Number(doc.monthlyFee || 0),
        appliedAt: String(doc.appliedAt || ""),
        status:
          doc.status === "accepted" || doc.status === "rejected"
            ? doc.status
            : "pending",
      }));

      return res.status(200).json({
        error: false,
        msg: "Tutor applications fetched",
        data: formatted,
      });
    } catch (err) {
      console.error("GET /applications/tutor error:", err);
      return res.status(500).json({
        error: true,
        msg: "Failed to fetch tutor applications",
      });
    }
  }
);


app.delete(
  "/applications/:id",
  verifyToken,
  requireRole("student"),
  async (req, res) => {
    try {
      const database = await connectToMongoDB();
      const applicationsCol = database.collection("applications");
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ error: true, msg: "Invalid application ID" });
      }

      const studentEmail = String(req.user?.email || "").toLowerCase();
      const studentId = String(req.user?.id || "");

      const existing = await applicationsCol.findOne({
        _id: new ObjectId(id),
        $or: [{ studentEmail }, { studentId }],
      });

      if (!existing) {
        return res
          .status(404)
          .json({ error: true, msg: "Application not found" });
      }

      await applicationsCol.deleteOne({ _id: new ObjectId(id) });

      return res.status(200).json({
        error: false,
        msg: "Application deleted",
      });
    } catch (err) {
      console.error("DELETE /applications/:id error:", err);
      return res.status(500).json({
        error: true,
        msg: "Failed to delete application",
      });
    }
  }
);

app.get(
  "/applications/mine",
  verifyToken,
  requireRole("student"),
  async (req, res) => {
    try {
      const database = await connectToMongoDB();
      const applicationsCol = database.collection("applications");

      const studentId = String(req.user?.id || "");
      const studentEmail = String(req.user?.email || "").toLowerCase();

      const conditions = [];
      if (studentId) {
        conditions.push({ studentId });
      }
      if (studentEmail) {
        conditions.push({ studentEmail });
      }

      if (conditions.length === 0) {
        return res.status(200).json({
          error: false,
          msg: "Student applications fetched",
          data: [],
        });
      }

      const docs = await applicationsCol
        .find(conditions.length === 1 ? conditions[0] : { $or: conditions })
        .sort({ _id: -1 })
        .toArray();

      const formatted = docs.map((doc) => ({
        id: String(doc._id),
        tuitionId: String(doc.tuitionId || ""),
        tuitionTitle: String(doc.tuitionTitle || "Tuition"),
        tutorName: String(doc.tutorName || ""),
        tutorEmail: String(doc.tutorEmail || ""),
        studentName: String(doc.studentName || req.user?.name || "Student"),
        studentEmail: String(doc.studentEmail || studentEmail),
        studentPhone: String(doc.studentPhone || ""),
        preferredSchedule: String(doc.preferredSchedule || ""),
        note: String(doc.note || ""),
        monthlyFee: Number(doc.monthlyFee || 0),
        appliedAt: String(doc.appliedAt || ""),
        status:
          doc.status === "accepted" || doc.status === "rejected"
            ? doc.status
            : "pending",
      }));

      return res.status(200).json({
        error: false,
        msg: "Student applications fetched",
        data: formatted,
      });
    } catch (err) {
      console.error("GET /applications/mine error:", err);
      return res.status(500).json({
        error: true,
        msg: "Failed to fetch student applications",
      });
    }
  }
);


app.patch(
  "/applications/:id/status",
  verifyToken,
  requireRole("tutor"),
  async (req, res) => {
    try {
      const database = await connectToMongoDB();
      const applicationsCol = database.collection("applications");
      const { id } = req.params;
      const status = req.body?.status;

      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ error: true, msg: "Invalid application ID" });
      }

      if (status !== "accepted" && status !== "rejected") {
        return res
          .status(400)
          .json({ error: true, msg: "Status must be accepted or rejected" });
      }

      const tutorEmail = String(req.user?.email || "").toLowerCase();
      const tutorId = String(req.user?.id || "");

      const result = await applicationsCol.updateOne(
        {
          _id: new ObjectId(id),
          $or: [{ tutorEmail }, { tutorId }],
        },
        {
          $set: {
            status,
            updatedAt: new Date().toISOString(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res
          .status(404)
          .json({ error: true, msg: "Application not found" });
      }

      return res.status(200).json({
        error: false,
        msg: `Application marked as ${status}`,
      });
    } catch (err) {
      console.error("PATCH /applications/:id/status error:", err);
      return res.status(500).json({
        error: true,
        msg: "Failed to update application status",
      });
    }
  }
);

const FREE_BOOKMARK_LIMIT = 5;

app.get("/tuitions/:id", async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: true, msg: "Invalid tuition ID" });
    }

    const tuition = await database
      .collection("tuitions")
      .findOne({ _id: new ObjectId(id) });

    if (!tuition) {
      return res.status(404).json({ error: true, msg: "Tuition not found" });
    }

    return res.status(200).json({
      error: false,
      msg: "Tuition fetched",
      data: { ...tuition, _id: String(tuition._id) },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: true, msg: "Failed to fetch tuition" });
  }
});

app.post("/applications", verifyToken, requireRole("student"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const { tuitionId, preferredSchedule, phone, note } = req.body || {};

    if (!tuitionId || !ObjectId.isValid(tuitionId)) {
      return res.status(400).json({ error: true, msg: "Invalid tuition ID" });
    }

    const tuition = await database
      .collection("tuitions")
      .findOne({ _id: new ObjectId(tuitionId) });

    if (!tuition) {
      return res.status(404).json({ error: true, msg: "Tuition not found" });
    }

    const studentEmail = String(req.user.email || "").toLowerCase();
    const tutorEmail = String(tuition.tutorEmail || "").toLowerCase();

    const doc = {
      tuitionId: String(tuitionId),
      tuitionTitle: tuition.title || "Tuition",
      tutorId: String(tuition.tutorId || ""),
      tutorName: tuition.tutorName || "",
      tutorEmail,
      studentId: String(req.user.id || ""),
      studentName: req.user.name || "Student",
      studentEmail,
      studentPhone: String(phone || ""),
      preferredSchedule: String(preferredSchedule || ""),
      note: String(note || ""),
      monthlyFee: Number(tuition.monthlyFee || 0),
      appliedAt: formatDate(new Date()),
      status: "pending",
    };

    await database.collection("applications").insertOne(doc);
    await database
      .collection("tuitions")
      .updateOne(
        { _id: new ObjectId(tuitionId) },
        { $inc: { applicantsCount: 1 } }
      );

    return res.status(201).json({
      error: false,
      msg: "Application submitted with pending status",
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: true, msg: "Failed to submit application" });
  }
});

app.get("/bookmarks/mine", verifyToken, requireRole("student"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const studentEmail = String(req.user.email || "").toLowerCase();

    const docs = await database
      .collection("bookmarks")
      .find({
        $or: [{ studentEmail }, { studentId: String(req.user.id || "") }],
      })
      .sort({ _id: -1 })
      .toArray();

    return res.status(200).json({
      error: false,
      msg: "Bookmarks fetched",
      data: docs.map((d) => ({
        id: String(d._id),
        tuitionId: String(d.tuitionId),
        studentEmail: d.studentEmail || studentEmail,
        createdAt: d.createdAt || "",
      })),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: true, msg: "Failed to fetch bookmarks" });
  }
});

app.post("/bookmarks", verifyToken, requireRole("student"), async (req, res) => {
  try {
    const database = await connectToMongoDB();
    const bookmarksCol = database.collection("bookmarks");
    const usersCol = database.collection("user");

    const tuitionId = String(req.body?.tuitionId || "");
    if (!tuitionId || !ObjectId.isValid(tuitionId)) {
      return res.status(400).json({ error: true, msg: "Invalid tuition ID" });
    }

    const studentEmail = String(req.user.email || "").toLowerCase();

    const existing = await bookmarksCol.findOne({
      tuitionId,
      $or: [{ studentEmail }, { studentId: String(req.user.id || "") }],
    });

    if (existing) {
      return res.status(200).json({ error: false, msg: "Already bookmarked" });
    }

    const userDoc = await usersCol.findOne(
      buildUserFilter(req.user.id, studentEmail)
    );
    const isPro = userDoc?.plan === "pro";

    if (!isPro) {
      const count = await bookmarksCol.countDocuments({
        $or: [{ studentEmail }, { studentId: String(req.user.id || "") }],
      });

      if (count >= FREE_BOOKMARK_LIMIT) {
        return res.status(403).json({
          error: true,
          msg: `Free Students can bookmark up to ${FREE_BOOKMARK_LIMIT} tuitions. Upgrade to Pro Student for unlimited bookmarks.`,
        });
      }
    }

    await bookmarksCol.insertOne({
      tuitionId,
      studentId: String(req.user.id || ""),
      studentEmail,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({ error: false, msg: "Tuition bookmarked" });
  } catch (err) {
    return res
      .status(500)
      .json({ error: true, msg: "Failed to bookmark tuition" });
  }
});

app.delete(
  "/bookmarks/:tuitionId",
  verifyToken,
  requireRole("student"),
  async (req, res) => {
    try {
      const database = await connectToMongoDB();
      const { tuitionId } = req.params;
      const studentEmail = String(req.user.email || "").toLowerCase();

      await database.collection("bookmarks").deleteOne({
        tuitionId: String(tuitionId),
        $or: [{ studentEmail }, { studentId: String(req.user.id || "") }],
      });

      return res.status(200).json({ error: false, msg: "Bookmark removed" });
    } catch (err) {
      return res
        .status(500)
        .json({ error: true, msg: "Failed to remove bookmark" });
    }
  }
);

app.get("/user", verifyToken, async (req, res) => {
  // try {
  const database = await connectToMongoDB();
  const usersCol = database.collection("user");
  console.log(req.body)
  // const user = usersCol
  //   const userFilter = buildUserFilter(req.user.id, req.user.email);
  //   const userDoc = userFilter ? await usersCol.findOne(userFilter) : null;

  //   const paymentFilter = {
  //     $or: [
  //       ...(req.user.id ? [{ userId: String(req.user.id) }] : []),
  //       ...(req.user.email
  //         ? [{ userEmail: String(req.user.email).toLowerCase() }]
  //         : []),
  //     ],
  //   };

  //   const payments = await paymentsCol
  //     .find(paymentFilter)
  //     .sort({ createdAt: -1 })
  //     .toArray();

  //   console.log(payments)
  //   const isPro = userDoc?.plan === "pro" || payments.length > 0;

  //   return res.status(200).json({
  //     error: false,
  //     msg: isPro ? "User has an active Pro plan" : "User is on the Free plan",
  //     data: {
  //       isPro,
  //       plan: isPro ? "pro" : "free",
  //       latestPayment: payments[0] || null,
  //       payments,
  //     },
  //   });
  // } catch (err) {
  //   console.error("Check user paid status error:", err);
  //   return res
  //     .status(500)
  //     .json({ error: true, msg: "Failed to check payment status" });
  // }
});

app.listen(port, () => {
  console.log(`Mentor Lagbe server running on port ${port}`);
});