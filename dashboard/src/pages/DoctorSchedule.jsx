import { useEffect, useState } from "react";
import Shell from "../components/Shell";
import ReceptionCalendar from "../components/ReceptionCalendar";
import { todayISO } from "../lib/api";

export default function DoctorSchedule() {
  const [calendarDate, setCalendarDate] = useState(todayISO());
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // Keep the calendar reasonably fresh even though this is now its own
  // page (previously it refreshed whenever the Appointments page marked a
  // patient arrived/no-show/attended, via a shared refreshKey).
  useEffect(() => {
    const id = setInterval(() => setRefreshKey((k) => k + 1), 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <Shell title="Doctor schedule" subtitle="Live view of today's clinic timings and booked appointments.">
      <ReceptionCalendar date={calendarDate} setDate={setCalendarDate} search={search} setSearch={setSearch} refreshKey={refreshKey} />
    </Shell>
  );
}
