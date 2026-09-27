-- Create Enum for Course Status
CREATE TYPE course_status AS ENUM ('Active', 'Inactive', 'Archived');

-- Create Courses Table
CREATE TABLE courses (
    course_id SERIAL PRIMARY KEY,
    course_code VARCHAR(20) UNIQUE NOT NULL,       -- e.g., 'NIT-CRS-018'
    course_title VARCHAR(255) NOT NULL,             -- e.g., 'Data Science with Python...'
    category VARCHAR(100) NOT NULL,                 -- e.g., 'Data & Analytics'
    standard_fee NUMERIC(10, 2) NOT NULL CHECK (standard_fee >= 0), -- e.g., 30000.00
    is_combo BOOLEAN DEFAULT FALSE,                 -- TRUE for combo records, FALSE for standalone
    status course_status DEFAULT 'Active',          -- 'Active', 'Inactive', etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Junction Table for Course-Branch Mapping (Many-to-Many)
CREATE TABLE course_branches (
    course_id INT REFERENCES courses(course_id) ON DELETE CASCADE,
    branch_code VARCHAR(20) NOT NULL,              -- e.g., 'NIT-GNT', 'NIT-VIJ'
    PRIMARY KEY (course_id, branch_code)
);
