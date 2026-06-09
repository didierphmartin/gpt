<?php
// Simple debug file to test if backend is accessible
header('Content-Type: application/json');
echo json_encode([
    'message' => 'Backend is accessible!',
    'file' => __FILE__,
    'time' => date('Y-m-d H:i:s')
]);
