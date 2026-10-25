# SeatLock

A concurrency-safe event ticket booking API. Users hold seats for 15 minutes while they pay, unpaid holds expire automatically, and the same seat can never be sold twice, even when many people try to book it at the same moment.

Built with **Node.js, Express 5, TypeScript, PostgreSQL, Prisma 7 and Better Auth**.

> **Status: work in progress.** Authentication, database schema and project setup are done. Event, booking and payment modules are being built. See the [Roadmap](#roadmap) for what works today.

---

## Why this project

When thousands of people try to buy the same seat at once, a naive "check if free, then book" flow sells it twice. SeatLock solves this with database-level guarantees instead of hoping the application code is perfect. It is the same class of problem behind cinema, airline, hotel and concert booking systems.

## Features

**Working now**
- Email and password authentication (sign up, sign in, sessions) with [Better Auth](https://www.better-auth.com)
- Role-based access control (`USER`, `ORGANIZER`, `ADMIN`)
- Protected routes with `requireAuth` and `requireRole` middleware
- Full PostgreSQL schema (events, tiers, seats, bookings, payments, webhooks, audit log) managed with Prisma migrations
- Health check endpoint

**Planned**
- Event, ticket tier and seat management for organizers
- Seat hold with 15 minute expiry and automatic release
- Idempotent booking requests
- Stripe payments with idempotent webhook handling
- Cancellation and refunds
- Concurrency test (50 parallel requests for one seat)
- Next.js dashboard with seat map and checkout countdown

## How double-booking is prevented (design)

1. **Atomic conditional update:** a seat moves from `AVAILABLE` to `HELD` only if it is still `AVAILABLE`. If the number of updated rows is smaller than the number of requested seats, the whole transaction rolls back.
2. **Row locks:** `SELECT ... FOR UPDATE` in a fixed order to avoid deadlocks.
3. **Database safety net:** a partial unique index on active booking items, so even a bug in application code cannot create a double booking.
4. **Idempotency keys:** the same booking request sent twice returns the original booking.
5. **Webhook deduplication:** payment provider event ids are stored with a unique constraint, so each event is processed once.
6. **Expiry job:** a scheduled job releases seats from `PENDING` bookings whose hold time has passed.

```mermaid
sequenceDiagram
    participant U as User
    participant API as API
    participant DB as PostgreSQL
    participant S as Stripe

    U->>API: POST /bookings (seatIds, Idempotency-Key)
    API->>DB: BEGIN, hold seats if AVAILABLE
    DB-->>API: rows updated = N
    API->>DB: create PENDING booking (expires in 15 min), COMMIT
    API-->>U: 201 booking
    U->>API: POST /bookings/:id/pay
    API->>S: create payment
    S->>API: webhook payment succeeded
    API->>DB: booking CONFIRMED, seats SOLD
```

## Tech stack

| Area | Technology |
|---|---|
| Runtime | Node.js 22+ (ESM) |
| Framework | Express 5 |
| Language | TypeScript |
| Database | PostgreSQL |
| ORM | Prisma 7 with the `pg` driver adapter |
| Auth | Better Auth (email and password, sessions) |
| Validation | Zod |
| Testing | Vitest, Supertest |
| Planned | Stripe, node-cron, Next.js, Docker, GitHub Actions |

## Project structure

```
seatlock/
├── api/
│   ├── prisma/
│   │   └── schema.prisma
│   ├── prisma7.config.ts
│   ├── src/
│   │   ├── app.ts             # Express app, routes, middleware
│   │   ├── server.ts          # entry point
│   │   ├── lib/
│   │   │   ├── auth.ts        # Better Auth configuration
│   │   │   └── prisma.ts      # Prisma client
│   │   ├── middlewares/
│   │   │   └── auth.ts        # requireAuth, requireRole
│   │   └── tests/
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

## Getting started

### Prerequisites
- Node.js 22 or newer
- PostgreSQL running locally
- Git

### 1. Clone and install

```bash
git clone https://github.com/imtiaz-zihad/SeatLock.git
cd SeatLock/api
npm install
```

### 2. Create the database

```bash
psql -U postgres -c "CREATE DATABASE seatlock;"
```

(Or create a database named `seatlock` from pgAdmin.)

### 3. Configure environment variables

Create `api/.env`:

```env
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/seatlock"
BETTER_AUTH_SECRET="a-long-random-string"
BETTER_AUTH_URL="http://localhost:4000"
CORS_ORIGIN="http://localhost:3000"
PORT=4000
```

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 4. Create tables and generate the Prisma client

```bash
npm run db:migrate -- --name init
npx prisma generate
```

### 5. Run

```bash
npm run dev
```

The API runs at `http://localhost:4000`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server with auto-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Run tests |
| `npm run typecheck` | Type-check without building |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:studio` | Open Prisma Studio |

## API

### Available now

| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/health` | Public | Service health |
| GET | `/api/auth/ok` | Public | Better Auth status |
| POST | `/api/auth/sign-up/email` | Public | Create account |
| POST | `/api/auth/sign-in/email` | Public | Sign in (sets session cookie) |
| GET | `/api/auth/get-session` | Cookie | Current session |
| GET | `/api/me` | Signed in | Current user |
| GET | `/api/organizer/ping` | Organizer, Admin | Role check example |

### Planned

| Area | Endpoints |
|---|---|
| Events | `GET/POST /events`, `PATCH /events/:id`, `POST /events/:id/publish`, `POST /events/:id/cancel` |
| Tiers and seats | `POST /events/:id/tiers`, `POST /events/:id/seats/bulk`, `GET /events/:id/seats` |
| Bookings | `POST /bookings`, `GET /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel` |
| Payments | `POST /bookings/:id/pay`, `POST /webhooks/stripe` |
| Admin | `GET /admin/stats`, `GET /admin/audit-logs` |

### Quick try

```bash
# sign up
curl -X POST http://localhost:4000/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","password":"StrongPass123!"}'
```

Roles cannot be chosen at sign-up. To try organizer routes, change a user's `role` to `ORGANIZER` in Prisma Studio (`npm run db:studio`).

## Data model

Authentication: `User`, `Session`, `Account`, `Verification` (Better Auth).
Domain: `Event`, `TicketTier`, `Seat`, `Booking`, `BookingItem`, `Payment`, `WebhookEvent`, `AuditLog`.

Booking states: `PENDING → CONFIRMED → REFUNDED`, `PENDING → EXPIRED`, `PENDING → CANCELLED`.
Seat states: `AVAILABLE → HELD → SOLD`.

## Testing

```bash
npm test
npm run typecheck
```

A concurrency test (many parallel requests for one seat, exactly one succeeds) is planned together with the booking module.

## Roadmap

- [x] Project setup (TypeScript, ESM, Express 5)
- [x] PostgreSQL schema and Prisma 7 migrations
- [x] Authentication and roles with Better Auth
- [ ] Basic tests (health check, auth mount)
- [ ] Events, tiers and seats
- [ ] Booking with seat hold, transactions and idempotency
- [ ] Hold expiry job
- [ ] Stripe payments and webhooks
- [ ] Cancellation and refunds
- [ ] Concurrency and load tests
- [ ] Next.js dashboard
- [ ] Docker and GitHub Actions CI
- [ ] Deployment and API docs (Swagger)

## Security notes

- Secrets live in `.env`, which is git-ignored. Never commit it.
- Users cannot set their own role at sign-up.
- The Better Auth handler is mounted before `express.json()`, as required by the library.