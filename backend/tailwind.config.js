module.exports = {
  content: ["./src/views/**/*.ejs", "./src/**/*.js"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Fraunces", "Times New Roman", "serif"],
        sans: ["IBM Plex Sans", "Segoe UI", "sans-serif"],
        urdu: ["Noto Nastaliq Urdu", "IBM Plex Sans", "sans-serif"],
      },
      colors: {
        ink: "#1c2430",
        muted: "#5e6a7b",
        accent: "#14526a",
      },
    },
  },
  plugins: [],
};
