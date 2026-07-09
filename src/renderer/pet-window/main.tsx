import React from "react";
import ReactDOM from "react-dom/client";
import { PetWindow } from "./PetWindow";
import "./pet-window.css";

ReactDOM.createRoot(document.getElementById("pet-root") as HTMLElement).render(
  <React.StrictMode>
    <PetWindow />
  </React.StrictMode>
);
