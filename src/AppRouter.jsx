import React from "react";
import App from "./App.jsx";
import InferencePage from "./InferencePage.jsx";

export default function AppRouter() {
  return window.location.pathname === "/inferencePage" ? <InferencePage /> : <App />;
}
