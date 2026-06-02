/**
 * Reusable OpenAPI component schemas referenced via $ref in route annotations.
 * Keeping schemas here avoids duplicating type definitions in YAML comments.
 */
export const components = {
    schemas: {
        HealthResponse: {
            type: 'object',
            required: ['status', 'uptime', 'timestamp'],
            properties: {
                status: { type: 'string', example: 'ok' },
                uptime: { type: 'number', description: 'Process uptime in seconds', example: 42.3 },
                timestamp: { type: 'string', format: 'date-time' },
            },
        },
        BoundingBox: {
            type: 'object',
            description: 'Pixel coordinates relative to the 640×640 resized image',
            required: ['x1', 'y1', 'x2', 'y2'],
            properties: {
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
            },
        },
        Detection: {
            type: 'object',
            required: ['classId', 'className', 'confidence', 'box'],
            properties: {
                classId: { type: 'integer', enum: [0, 1, 2], description: '0=Belum Matang, 1=Matang, 2=Rusak' },
                className: { type: 'string', enum: ['Belum Matang', 'Matang', 'Rusak'] },
                confidence: { type: 'number', minimum: 0, maximum: 1, example: 0.91 },
                box: { $ref: '#/components/schemas/BoundingBox' },
            },
        },
        AnalyzeResponse: {
            type: 'object',
            required: ['success', 'timestamp', 'detections_found', 'detections', 'farm_control_action'],
            properties: {
                success: { type: 'boolean', example: true },
                timestamp: { type: 'string', format: 'date-time' },
                detections_found: { type: 'integer', example: 7 },
                detections: {
                    type: 'array',
                    maxItems: 5,
                    items: { $ref: '#/components/schemas/Detection' },
                },
                farm_control_action: {
                    type: 'string',
                    enum: ['maintain_current_state', 'flush_nutrients_and_increase_watering', 'extend_light_cycle_brightness'],
                    example: 'maintain_current_state',
                },
            },
        },
        ErrorResponse: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: false },
                error: { type: 'string' },
            },
        },
    },
};
