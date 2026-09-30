/** Compatibility for links to the former pilot route. Both servers use the same UI. */
import { Redirect } from 'expo-router';
export default function NativeRoute() { return <Redirect href="/" />; }
