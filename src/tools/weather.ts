import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { loadConfig, setLocation } from "../core/config.js";

const WMO: Record<number, string> = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "icy fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

interface GeoHit {
  latitude: number;
  longitude: number;
  name: string;
  country?: string;
  population?: number;
}

// Open-Meteo indexes cities under their English names by default, so a query
// for "Napoli" finds a village in The Gambia rather than the Italian city —
// and its results aren't ranked by prominence. So: search every configured
// language, merge by coordinates, and let the most populous match win.
async function geocode(city: string): Promise<{ lat: number; lon: number; label: string }> {
  const langs = loadConfig().geocodeLanguages;
  const byPlace = new Map<string, GeoHit>();
  let reached = false;

  for (const lang of langs) {
    let res: Response;
    try {
      res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=${encodeURIComponent(lang)}`,
      );
    } catch {
      continue; // try the next language rather than failing the whole lookup
    }
    if (!res.ok) continue;
    reached = true;
    const json = (await res.json()) as { results?: GeoHit[] };
    for (const r of json.results ?? []) {
      const key = `${r.latitude.toFixed(2)},${r.longitude.toFixed(2)}`;
      const existing = byPlace.get(key);
      if (!existing || (r.population ?? 0) > (existing.population ?? 0)) byPlace.set(key, r);
    }
  }

  if (!reached) throw new Error("the geocoding service is unreachable right now");
  const best = [...byPlace.values()].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
  if (!best) throw new Error(`I couldn't find a place called "${city}"`);
  return {
    lat: best.latitude,
    lon: best.longitude,
    label: `${best.name}${best.country ? ", " + best.country : ""}`,
  };
}

export const weatherTools: EveTool[] = [
  {
    name: "get_weather",
    description:
      "Weather and daylight for a city, today or tomorrow: current conditions, high/low, rain chance, and the exact sunrise and sunset times (in that city's local time). Use this for the daily briefing, for any weather question, and for any 'what time is sunrise/sunset' question. If no city is given, uses Umberto's configured home city.",
    schema: z.object({
      city: z
        .string()
        .optional()
        .describe("City name, e.g. 'Barcelona'. Omit for his configured home city."),
      day: z
        .enum(["today", "tomorrow"])
        .default("today")
        .describe("Which day to report on."),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const cfg = loadConfig();
      let lat: number, lon: number, label: string;
      if (input.city) {
        ({ lat, lon, label } = await geocode(String(input.city)));
      } else if (cfg.location.lat !== null && cfg.location.lon !== null) {
        lat = cfg.location.lat;
        lon = cfg.location.lon;
        label = cfg.location.city || "home";
      } else {
        throw new Error(
          "no home city is configured — ask Umberto which city he lives in, then use set_location",
        );
      }
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&current=temperature_2m,weather_code,wind_speed_10m` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,daylight_duration` +
          `&timezone=auto&forecast_days=2`,
      );
      if (!res.ok) throw new Error(`weather service failed (${res.status})`);
      const j = (await res.json()) as {
        timezone: string;
        current: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
        daily: {
          time: string[];
          weather_code: number[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_probability_max: number[];
          sunrise: string[];
          sunset: string[];
          daylight_duration: number[];
        };
      };
      const i = input.day === "tomorrow" ? 1 : 0;
      const d = j.daily;
      if (d.time[i] === undefined) throw new Error(`no forecast available for ${String(input.day)}`);
      const clock = (iso: string | undefined) => (iso ? iso.slice(11, 16) : "unknown");
      const secs = d.daylight_duration[i] ?? 0;
      const daylight = `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
      const sky = WMO[d.weather_code[i] ?? -1] ?? "unclear skies";

      const now =
        i === 0
          ? `Right now: ${j.current.temperature_2m}°C, ${WMO[j.current.weather_code] ?? "unknown sky"}, wind ${j.current.wind_speed_10m} km/h. `
          : "";
      return (
        `${label} — ${input.day} (${d.time[i]}, local time ${j.timezone}). ` +
        now +
        `Forecast: ${sky}, ${d.temperature_2m_min[i]}–${d.temperature_2m_max[i]}°C, ` +
        `${d.precipitation_probability_max[i]}% chance of rain. ` +
        `Sunrise ${clock(d.sunrise[i])}, sunset ${clock(d.sunset[i])} (${daylight} of daylight).`
      );
    },
  },
  {
    name: "set_location",
    description:
      "Set Umberto's home city (used for weather in the daily briefing). This changes a setting, so it requires his explicit confirmation.",
    schema: z.object({
      city: z.string().min(2).describe("City name, e.g. 'Napoli'"),
    }),
    needsConfirmation: true,
    run: async (input) => {
      const { lat, lon, label } = await geocode(String(input.city));
      setLocation({ city: label, lat, lon });
      return `Home city is now ${label} (${lat}, ${lon}).`;
    },
  },
];
