// The logged-in user as the service layer sees it.
export type Actor = {
  id: string;
  role: string; // USER | ORGANIZER | ADMIN
};
