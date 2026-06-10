module.exports = {
  content: ["./src/views/**/*.ejs", "./src/**/*.js"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ["Fraunces", "Times New Roman", "serif"],
        sans: ["IBM Plex Sans", "Segoe UI", "sans-serif"],
        urdu: ["Noto Nastaliq Urdu", "IBM Plex Sans", "sans-serif"],
      },
      colors: {
        ink: "#1c2430",
        muted: "#475569",
        accent: "#14526a",
      },
    },
  },
  plugins: [],
};
