const titlesByCategory = {
  IT: [
    "Python Full Stack Development",
    "Java Full Stack Development",
    "MERN Stack (MongoDB, Express, React, Node)",
    "MEAN Stack (MongoDB, Express, Angular, Node)",
    "Frontend Development (HTML5, CSS3, JS, React, Vue, Angular)",
    "Backend Development (Node.js, Express, Django, FastAPI, Spring Boot)",
    "C, C++ & Data Structures (DSA)",
    ".NET & C# Full Stack Development",
    "Database Management (SQL, MySQL, PostgreSQL, MongoDB, Oracle)",
    "AI, Machine Learning & Generative AI",
    "Data Science & Data Analytics (Power BI, Tableau, Pandas)",
    "Cybersecurity, Ethical Hacking & Network Security",
    "Cloud Computing (AWS, Azure, GCP) & DevOps (Docker, Kubernetes)",
    "Mobile App Development (Flutter, React Native, Android Studio)",
    "Software Testing & Automation (Selenium, Manual Testing)",
    "UI/UX Design & Prototyping (Figma, Adobe XD)",
    "Embedded Systems & IoT (Internet of Things)",
    "Career Readiness, Live Projects & Tech Mentorship",
  ],
  "Non-IT": [
    "Digital Marketing & SEO",
    "Business Development & Sales",
    "Human Resource Management (HR)",
    "Financial Accounting & Tally",
    "Banking, Insurance & Financial Services",
    "Supply Chain & Logistics Management",
    "Soft Skills & Business Communication",
    "Customer Relationship Management (CRM)",
    "Office Administration & Secretarial Skills",
    "Retail & Store Operations Management",
    "Project Management Fundamentals",
    "Quality Assurance & ISO Standards",
  ],
};

const programs = Object.entries(titlesByCategory).flatMap(([category, titles]) =>
  titles.map((title) => ({
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    title,
    category,
    summary: `Build practical skills in ${title} through guided learning, hands-on exercises and project work.`,
    outcomes: `Develop a practical foundation in ${title} and apply it with confidence.`,
  }))
);

module.exports = {
  programs,
  programById: new Map(programs.map((program) => [program.id, program])),
  durations: ["1 month", "3 months", "6 months"],
};
