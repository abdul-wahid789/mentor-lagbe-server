# Mentor Lagbe Server

## Short Description

Mentor Lagbe Server is the RESTful backend API powering the **Mentor Lagbe** tuition and mentorship marketplace. Built with **Express.js 5** and **MongoDB Atlas** using ES Modules, it is engineered for Vercel's serverless environment with cached database connections, remote **JWKS** JWT verification via `jose`, role-based access control (`student`, `tutor`, `admin`), and **Stripe** checkout integration for Pro memberships.

- **Backend API:** [mentor-lagbe-server-ruddy.vercel.app](https://mentor-lagbe-server-ruddy.vercel.app/)
- **Frontend App:** [mentor-lagbe-client-ashen.vercel.app](https://mentor-lagbe-client-ashen.vercel.app/)

---

## Key Features

- **Remote JWKS & JWT Authentication (`jose`)**
  Verifies Bearer tokens issued by the frontend's Better Auth server against its remote JWKS endpoint (`/api/auth/jwks`) using `createRemoteJWKSet` and `jwtVerify`, validating both issuer and audience without sharing secrets.

- **Role-Based Access Control (RBAC)**
  Protects routes with `verifyToken` and `requireRole(...roles)` middleware to enforce strict boundaries between **Students**, **Tutors**, and **Admins** across tuition management, applications, moderation, and payment endpoints.

- **Tuition & Moderation Engine**
  - **Tutors** can create, update, toggle active status, and delete their tuition posts (enforcing a free-tier limit of 2 active tuitions unless upgraded to `pro`).
  - **Admins** can review pending tuition submissions, approve or reject posts with feedback notes, and manage user accounts and roles.
  - **Public / Students** can query approved, active tuitions, view homepage stats, and read/submit tuition feedbacks.

- **Student Applications & Bookmarks**
  Students can apply to approved tuitions (preventing duplicate applications), manage their applications, and bookmark listings; tutors can review and accept/reject incoming applicants.

- **Stripe Checkout & Plan Upgrades**
  Creates Stripe Checkout sessions (`/checkout`) for **Pro Student** and **Pro Tutor** plans, verifies payment status on `/payment/success`, records idempotent payment transactions in MongoDB (`payments` collection), and upgrades the user's `plan` to `"pro"`.

- **Serverless-Ready MongoDB & CORS**
  Reuses the MongoDB client connection across serverless invocations (`connectToMongoDB`) and configures credentialed CORS restricted to the configured `CLIENT_URL`.

---

## Technologies Used

- **Runtime & Framework:** Node.js (ES Modules), Express.js 5
- **Database:** MongoDB Atlas (`mongodb` v7)
- **Authentication & Security:** `jose` (Remote JWKS & JWT verification), `cors`
- **Payments:** Stripe (`stripe` v23)
- **Configuration & Dev Tooling:** `dotenv`, `nodemon`

---

## API Overview

| Group | Endpoints | Access |
| :--- | :--- | :--- |
| **Health** | `GET /` | Public |
| **Payments** | `POST /checkout`, `GET /payment/success`, `GET /payment/cancel`, `GET /transactions`, `GET /user/paid` | Authenticated / Stripe Redirect |
| **Tuitions** | `GET /tuitions`, `GET /tuitions/:id`, `GET /tuitions/mine`, `POST /tuition`, `PATCH /tuition/:id`, `DELETE /tuition/:id` | Public / Tutor |
| **Applications & Bookmarks** | `POST /applications`, `GET /bookmarks/mine`, `POST /bookmarks`, applicant & status routes | Student / Tutor |
| **Feedback & Stats** | `GET /tuitions/:id/feedbacks`, `POST /tuitions/:id/feedbacks`, `GET /feedbacks/recent`, `GET /stats/home` | Public / Authenticated |
| **Users & Admin** | `GET /user`, `PATCH /user/role`, `PATCH /user/profile`, admin user & tuition moderation routes | Authenticated / Admin |

---

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   Create a `.env` file in the root directory:
   ```env
   PORT=5000
   MONGO_URI=your_mongodb_connection_string
   CLIENT_URL=http://localhost:3000
   SERVER_URL=http://localhost:5000
   STRIPE_SECRET_KEY=your_stripe_secret_key
   ```

3. **Run in development:**
   ```bash
   npm run dev
   ```

4. **Verify server:**
   Open [http://localhost:5000](http://localhost:5000) — you should see `Hello from Mentor Lagbe Server`.
