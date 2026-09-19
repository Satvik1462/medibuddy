import Shell from "../components/Shell";
import PatientLookup from "../components/PatientLookup";

export default function Patients() {
  return (
    <Shell title="Patients" subtitle="Look up any patient by mobile number to see their full visit history.">
      <PatientLookup />
    </Shell>
  );
}
