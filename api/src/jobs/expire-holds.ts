import cron from "node-cron";
import { expireOverdueBookings } from "../modules/bookings/booking.service.js";

// Every minute: free the seats of bookings that were not paid in time.
// (Even without this job nobody is blocked: expired holds are treated as free
// while booking. The job keeps the data clean and the seat map exact.)
export function startExpiryJob() {
  let running = false; // never let two runs overlap in the same process

  return cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      const expired = await expireOverdueBookings();
      if (expired > 0) console.log(`[expiry job] expired ${expired} booking(s)`);
    } catch (err) {
      console.error("[expiry job] failed", err);
    } finally {
      running = false;
    }
  });
}
